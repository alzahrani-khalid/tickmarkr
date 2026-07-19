import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { Journal } from "../../src/run/journal.js";
import type { TelemetryRow } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

// VIS-05: `tickmarkr report` renders a "learning" section over the PREVIEW-mode profile (learning off),
// so the operator audits per-cell confidence BEFORE ever flipping routing.learned:on. profile.ts owns
// every derived number (cellSummary); report.ts only formats. Fixture is fully deterministic, zero tokens.
const done = (over: Partial<TelemetryRow> & Pick<TelemetryRow, "adapter" | "model">): TelemetryRow =>
  ({ taskId: "T", shape: "implement", channel: "sub", attempts: 1, outcome: "done", durationMs: 5,
     gateFails: 0, consults: 0, ...over });

// 6 runs run-l1..run-l6 (string sort IS chronological). WARM cell (claude-code:fable) gets one clean
// done per run ⇒ 6 rows, oldest (run-l1) at age 5 ⇒ weight 0.5 ⇒ nRaw 6 but n_eff 5.5 (decay visible).
// COLD + QUOTA cells live only in run-l6 (the reported run).
function repoWithLearning(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  let j6!: Journal;
  for (const i of [1, 2, 3, 4, 5, 6]) {
    const j = Journal.create(repo, `run-l${i}`);
    j.telemetry(done({ adapter: "claude-code", model: "fable" })); // WARM row, one per run
    if (i === 6) j6 = j;
  }
  j6.append("run-start", undefined, {}); // report() opens run-l6's journal
  // COLD: one clean done ⇒ nRaw 1, n_eff 1, cold(neutral), explore-left 4
  j6.telemetry(done({ adapter: "claude-code", model: "sonnet" }));
  // QUOTA: two quota parks ⇒ classified null ⇒ nRaw 0, quality "-", quotaHits 2, dispatches 2, cold
  j6.telemetry(done({ adapter: "claude-code", model: "haiku", outcome: "human", parkKind: "quota" }));
  j6.telemetry(done({ adapter: "claude-code", model: "haiku", outcome: "human", parkKind: "quota" }));
  // probes: two explore:true deviations + one explore-less ⇒ count is exactly 2, not 3
  j6.append("route-deviation", "T", { static: "a", chosen: "b", explore: true });
  j6.append("route-deviation", "T", { static: "a", chosen: "b", explore: true });
  j6.append("route-deviation", "T", { static: "a", chosen: "b" });
  return repo;
}

describe("tickmarkr report — learning section (VIS-05)", () => {
  test("preview-mode per-cell confidence: raw n vs n_eff, cold-neutral, quota, probe count", async () => {
    const out = await report(["run-l6"], repoWithLearning());

    // header names the current default (ROUTE-14 adopted on 2026-07-11); preview suffix drops when on
    expect(out).toMatch(/learning[^\n]*routing\.learned: on/);

    // WARM line: raw 6 AND n_eff 5.5 both present (the decay-visibility point), quality 1.00, quota 0
    expect(out).toMatch(/claude-code:fable[^\n]*raw=6[^\n]*n_eff=5\.5[^\n]*disp=6[^\n]*q=1\.00[^\n]*quota=0/);
    // COLD line: cold (neutral) label + exploration remaining 4
    expect(out).toMatch(/claude-code:sonnet[^\n]*explore-left=4[^\n]*cold \(neutral\)/);
    // QUOTA line: quotaHits 2 and quality "-"
    expect(out).toMatch(/claude-code:haiku[^\n]*q=-[^\n]*quota=2/);

    // probe count from route-deviation {explore:true} — exactly 2 (explore-less event NOT counted)
    expect(out).toMatch(/probes[^\n]*2/);
    expect(out).not.toMatch(/probes[^\n]*3/);

    // ABSENCE PINS (criterion 4) — each paired with a positive header twin so they can't pass vacuously
    expect(out).toMatch(/learning/);
    expect(out).not.toMatch(/confidence|±|interval/i);
    expect(out).not.toMatch(/flip|enable learning|turn .*on|recommend/i);

    // inherited spend pins — never NaN/undefined in rendered output
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/undefined/);
  });
});

describe("report.ts source pins — zero-arithmetic learning section (single-source, no hand-split)", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/cli/commands/report.ts", import.meta.url)), "utf8");

  test("no threshold constant, no cellKey hand-split — every number via cellsOf/cellSummary", () => {
    // single-source: report never names a threshold constant ⇒ a MIN_SAMPLES edit changes output with
    // zero report.ts edits (proves transitive import via cellSummary, not a hardcode)
    expect(src).not.toMatch(/MIN_SAMPLES|EXPLORE_CAP|NEUTRAL|qSum/);
    // no hand-split of the private cellKey
    expect(src).not.toMatch(/cellKey|lastIndexOf|\.split\(/);
    expect(src).toMatch(/cellsOf/);
    expect(src).toMatch(/cellSummary/);
    // preview-mode load (the trust ramp) + vacuity guard
    expect(src).toMatch(/preview:\s*true/);
    expect(src.length).toBeGreaterThan(500);
  });
});
