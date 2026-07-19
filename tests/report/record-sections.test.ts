import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type FixtureEvent = { event?: string; taskId?: string; data?: Record<string, unknown> };

function installRun(repo: string, fixture: string, runId: string, telemetryFixture = fixture): void {
  const dest = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dest, { recursive: true });
  cpSync(join(fixtures, fixture, "journal.jsonl"), join(dest, "journal.jsonl"));
  cpSync(join(fixtures, telemetryFixture, "telemetry.jsonl"), join(dest, "telemetry.jsonl"));
}

function readJournal(fixture: string): FixtureEvent[] {
  return readFileSync(join(fixtures, fixture, "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

function provenanceFor(fixture: string, taskId: string): string {
  const provenance = readJournal(fixture)
    .filter((event) => event.event === "task-dispatch" && event.taskId === taskId)
    .map((event) => event.data?.provenance)
    .filter((value): value is string => typeof value === "string")
    .join(" | ");
  if (!provenance) throw new Error(`fixture ${fixture} has no provenance for ${taskId}`);
  return provenance;
}

beforeEach(() => vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "tickmarkr-report-global-"))));
afterEach(() => vi.unstubAllEnvs());

describe("tickmarkr report --md against v1.17–v1.19 run fixtures", () => {
  test("an old v1.19 run without pricing renders not-measurable rows and efficiency counts", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803";
    installRun(repo, "old-run", runId);

    const out = await report([runId, "--md"], repo);

    expect(out).toContain("## Usage & efficiency");
    expect(out).toMatch(/\*\*pi:zai\/glm-5\.2\*\*[^\n]*price: not measurable/);
    expect(out).toMatch(/\*\*codex:gpt-5\.6-sol\*\*[^\n]*price: not measurable/);
    expect(out).toMatch(/\*\*claude-code:haiku\*\*[^\n]*price: not measurable/);
    expect(out).toContain("**done:** 5");
    expect(out).toContain("**first-attempt rate:** 3/5 (60%)");
    expect(out).toContain("**gate failures:** build: 1");
    expect(out).toContain("**consults:** 0");
    expect(out).toContain("**escalations:** 2");
    expect(out).toContain("**wall-clock:** 107m 18s");
  });

  test("v1.17 and v1.18 pre-report journals still render their usage sections", async () => {
    for (const fixture of ["run-20260712-190438", "run-20260712-193151"]) {
      const repo = makeRepo({ "keep.txt": "x\n" });
      installRun(repo, fixture, fixture);

      const out = await report([fixture, "--md"], repo);

      expect(out).toContain("## Usage & efficiency");
      expect(out).toContain("price: not measurable");
    }
  });

  test("a pricing fixture renders API math, sub amortization, and the API counterfactual", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803-priced";
    installRun(repo, "old-run", runId, "pricing");
    cpSync(join(fixtures, "pricing", "config.yaml"), join(tickmarkrDir(repo), "config.yaml"));

    const out = await report([runId, "--md"], repo);

    expect(out).toMatch(/\*\*opencode:opencode\/kimi-k2\*\*[^\n]*tokens: in 1,000,000  out 500,000[^\n]*price: \$6\.000000[^\n]*basis: in\/out \$2\/\$8\/Mtok; rate date 2026-07-13/);
    expect(out).toMatch(/\*\*pi:zai\/glm-5\.2\*\*[^\n]*windows: 3[^\n]*price: \$0\.250000–\$0\.750000 amortized[^\n]*API-equivalent: \$30\.000000/);
  });

  test("the task routing line preserves the fixture journal provenance exactly", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20260713-093803-routing";
    installRun(repo, "old-run", runId);

    const out = await report([runId, "--md"], repo);
    const t1 = out.slice(out.indexOf("## T1"), out.indexOf("\n## T2"));
    const routing = t1.split("\n").find((line) => line.startsWith("- **routing:** "));

    expect(routing).toBe(`- **routing:** ${provenanceFor("old-run", "T1")}`);
  });
});
