import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const corpusDir = join(import.meta.dirname, "../fixtures/journal-corpus");
const corpusFiles = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".jsonl"))
  .sort();

function corpusCaseTitle(file: string): string {
  return `old-corpus sweep: ${file} renders --md without throwing`;
}

describe("tickmarkr report --md (REC-01 execution record)", () => {
  test("synthetic journal renders outcome, attempts, channels, gates, consult, merge commit", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-md-full");
    j.append("run-start", undefined, { baseRef: "abc123def" });
    j.append("task-dispatch", "T1", {
      assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" },
      attempt: 0,
    });
    j.append("task-dispatch", "T1", {
      assignment: { adapter: "claude-code", model: "sonnet", channel: "sub", tier: "mid" },
      attempt: 1,
    });
    j.append("gate-result", "T1", { gate: "build", pass: true, details: "exit 0" });
    j.append("gate-result", "T1", { gate: "test", pass: false, details: "1 failed\nmore detail" });
    j.append("consult-verdict", "T1", { action: "retry", notes: "fix the test\nsecond line" });
    j.append("task-done", "T1", { attempts: 2 });
    j.append("merge", "T1", { branch: "tickmarkr/run-md-full--T1", commit: "deadbeef" });
    j.append("run-end", undefined, {
      runId: "run-md-full",
      branch: "tickmarkr/run-md-full",
      done: ["T1"],
      failed: [],
      human: [],
      blocked: [],
      pending: [],
    });

    const out = await report(["run-md-full", "--md"], repo);
    expect(out).toContain("# tickmarkr engagement");
    expect(out).toContain("## Audit trail");
    expect(out).toContain("**opinion:** unqualified");
    expect(out).toContain("**runId:** run-md-full");
    expect(out).toContain("**base ref:** abc123def");
    expect(out).toContain("**branch:** tickmarkr/run-md-full");
    expect(out).toContain("**done:** 1");
    expect(out).toContain("**failed:** 0");
    expect(out).toContain("**human:** 0");
    expect(out).toContain("## T1");
    expect(out).toContain("**opinion:** unqualified opinion");
    expect(out).toContain("**attempts:** 2");
    expect(out).toContain("**channels tried:** fake:fake-1, claude-code:sonnet");
    expect(out).toContain("build: pass — exit 0");
    expect(out).toContain("test: fail — 1 failed");
    expect(out).toContain("retry — fix the test");
    expect(out).toContain("- **tickmarks:**");
    expect(out).toContain("- **National Office:**");
    expect(out).toContain("**consolidation branch:** tickmarkr/run-md-full--T1");
    expect(out).toContain("**consolidation commit:** deadbeef");
  });

  test("sparse journal renders em-dash / not recorded and never throws", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-md-sparse");
    j.append("task-dispatch", "T9", {
      assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" },
      attempt: 0,
    });
    j.append("run-end", undefined, { done: ["T9"], failed: [], human: [] });

    const out = await report(["run-md-sparse", "--md"], repo);
    expect(out).toContain("**opinion:** unqualified opinion");
    expect(out).toContain("**attempts:** 1");
    expect(out).toContain("**channels tried:** fake:fake-1");
    expect(out).toContain("**consolidation branch:** —");
    expect(out).toContain("**consolidation commit:** —");
    expect(out).toMatch(/\*\*base ref:\*\* —/);
    expect(out).toMatch(/\*\*done:\*\* 1/);
  });

  describe("old-corpus sweep", () => {
    test("enumerates every .jsonl corpus file as its own case (count equals the directory listing)", () => {
      const listing = readdirSync(corpusDir).filter((f) => f.endsWith(".jsonl")).sort();
      expect(corpusFiles).toEqual(listing);
    });

    test("a corpus file that fails to render fails its own case naming the file", () => {
      const titles = corpusFiles.map(corpusCaseTitle);
      expect(new Set(titles).size).toBe(corpusFiles.length);
      for (const file of corpusFiles) {
        expect(titles.some((t) => t.includes(file))).toBe(true);
      }
    });

    for (const file of corpusFiles) {
      test(corpusCaseTitle(file), async () => {
        const repo = makeRepo({ "keep.txt": "x\n" });
        const runId = file.replace(/\.jsonl$/, "");
        const dest = join(repo, ".tickmarkr", "runs", runId);
        mkdirSync(dest, { recursive: true });
        cpSync(join(corpusDir, file), join(dest, "journal.jsonl"));
        await expect(report([runId, "--md"], repo)).resolves.toBeTypeOf("string");
      });
    }
  });
});
