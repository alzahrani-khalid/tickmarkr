import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

// v1.53 T5: supersession renders in the report header on BOTH runs — `superseded by` from the prior
// run's appended superseded event, `supersedes` from the superseding run's own run-start stamp.
describe("v1.53 supersession in the report header", () => {
  test("the report header of a superseded run names the superseding run", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-old");
    j.append("run-start", undefined, { baseRef: "x" });
    j.append("superseded", undefined, { by: "run-new" });
    const out = await report(["run-old"], repo);
    expect(out.split("\n\n")[0]).toContain("superseded by run-new"); // header block, before any section
    const md = await report(["run-old", "--md"], repo);
    expect(md).toContain("**superseded by:** run-new");
  });

  test("the report header of the superseding run names the run it supersedes", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-new");
    j.append("run-start", undefined, { baseRef: "x", supersedes: "run-old" });
    const out = await report(["run-new"], repo);
    expect(out.split("\n\n")[0]).toContain("supersedes run-old");
    const md = await report(["run-new", "--md"], repo);
    expect(md).toContain("**supersedes:** run-old");
  });
});

describe("tickmarkr report --md usage and efficiency", () => {
  test("renders measured and unmetered channels, deterministic efficiency, and routing evidence", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-record");
    writeFileSync(join(j.dir, "journal.jsonl"), [
      { ts: "2026-07-13T10:00:00.000Z", event: "run-start", data: {} },
      { ts: "2026-07-13T10:00:01.000Z", event: "task-dispatch", taskId: "T1", data: { provenance: "floor cheap (config floors), marginal-cost auto (via learned score 0.750 (n=6) over api:static 0.100)" } },
      { ts: "2026-07-13T10:00:02.000Z", event: "route-deviation", taskId: "T1", data: { static: "api:static", chosen: "api:metered", score: 0.75, staticScore: 0.1, n: 6 } },
      { ts: "2026-07-13T10:00:03.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: false } },
      { ts: "2026-07-13T10:00:04.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: false } },
      { ts: "2026-07-13T10:00:05.000Z", event: "consult-verdict", taskId: "T1", data: { action: "retry" } },
      { ts: "2026-07-13T10:00:06.000Z", event: "escalation", taskId: "T1", data: { step: "escalate" } },
      { ts: "2026-07-13T10:01:30.000Z", event: "run-end", data: {} },
    ].map(JSON.stringify).join("\n") + "\n");
    j.telemetry({ taskId: "T1", shape: "implement", adapter: "api", model: "metered", channel: "api", attempts: 1, outcome: "done", durationMs: 1, firstAttemptOk: true, tokens: { input: 1_000_000, output: 1_000_000 }, meteredAttempts: 1 });
    j.telemetry({ taskId: "T2", shape: "implement", adapter: "claude-code", model: "sub", channel: "sub", attempts: 2, outcome: "done", durationMs: 1, firstAttemptOk: false, tokens: { input: 1_000_000, output: 0 }, meteredAttempts: 2 });
    j.telemetry({ taskId: "T3", shape: "implement", adapter: "legacy", model: "unmetered", channel: "sub", attempts: 4, outcome: "done", durationMs: 1 });
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `cost:
  models:
    metered: { inPerMtok: 5, outPerMtok: 25, rateDate: 2026-07-13 }
    sub: { inPerMtok: 3, outPerMtok: 15, rateDate: 2026-07-13 }
  subs:
    claude-code: { planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 }
`);

    const journalBefore = readFileSync(join(j.dir, "journal.jsonl"));
    const telemetryBefore = readFileSync(join(j.dir, "telemetry.jsonl"));
    const out = await report(["run-record", "--md"], repo);

    expect(readFileSync(join(j.dir, "journal.jsonl"))).toEqual(journalBefore);
    expect(readFileSync(join(j.dir, "telemetry.jsonl"))).toEqual(telemetryBefore);
    expect(out).toContain("## Usage & efficiency");
    expect(out).toMatch(/api:metered[^\n]*tokens: in 1,000,000[^\n]*\$30[^\n]*basis:[^\n]*2026-07-13/);
    expect(out).toMatch(/claude-code:sub[^\n]*windows: 2[^\n]*\$0\.333333–\$1[^\n]*basis:/);
    expect(out).toMatch(/legacy:unmetered[^\n]*attempts\/windows: 4[^\n]*not measurable/);
    expect(out).toContain("**first-attempt rate:** 1/2 (50%)");
    expect(out).toContain("**gate failures:** build: 2");
    expect(out).toContain("**consults:** 1");
    expect(out).toContain("**escalations:** 1");
    expect(out).toContain("**wall-clock:** 1m 30s");
    expect(out).toContain("**routing:** floor cheap (config floors), marginal-cost auto (via learned score 0.750 (n=6) over api:static 0.100)");
    expect(out).toContain("**route deviation:** api:metered learned score 0.75 (n=6) vs static api:static 0.1");
  });
});
