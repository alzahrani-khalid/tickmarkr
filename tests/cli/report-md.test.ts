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

  // T11: a gate journaled skipped:true declined to run — the record says "declined", never "pass".
  describe("declined gates (T11)", () => {
    const declinedRun = (runId: string): string => {
      const repo = makeRepo({ "keep.txt": "x\n" });
      const j = Journal.create(repo, runId);
      j.append("run-start", undefined, { baseRef: "abc123def" });
      // T1: review ran and approved.
      j.append("task-dispatch", "T1", {
        assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" },
        attempt: 0,
      });
      j.append("gate-result", "T1", { gate: "build", pass: true, details: "exit 0" });
      j.append("gate-result", "T1", { gate: "review", pass: true, details: "reviewer claude-code:sonnet (anthropic): approved" });
      j.append("task-done", "T1", { attempts: 1 });
      // T2: review declined — below its complexity threshold, journaled skipped:true (daemon mapping).
      j.append("task-dispatch", "T2", {
        assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" },
        attempt: 0,
      });
      j.append("gate-result", "T2", { gate: "build", pass: true, details: "exit 0" });
      j.append("gate-result", "T2", { gate: "review", pass: true, details: "skipped — complexity 1 < threshold 4", skipped: true });
      j.append("task-done", "T2", { attempts: 1 });
      j.append("run-end", undefined, {
        runId,
        branch: `tickmarkr/${runId}`,
        done: ["T1", "T2"],
        failed: [],
        human: [],
        blocked: [],
        pending: [],
      });
      return repo;
    };

    // counts only tickmark lines ("  - <gate>: pass — …"), never task-level fields
    const passCount = (section: string): number =>
      section.split("\n").filter((line) => /^ {2}- \S+: pass — /.test(line)).length;

    test("test: a task whose review declined counts one fewer passed gate than a task whose review ran and passed", async () => {
      const repo = declinedRun("run-md-declined-count");
      const out = await report(["run-md-declined-count", "--md"], repo);
      const t1 = out.slice(out.indexOf("## T1"), out.indexOf("## T2"));
      const t2 = out.slice(out.indexOf("## T2"));
      expect(passCount(t1)).toBe(2); // build + review both ran and passed
      expect(passCount(t2)).toBe(passCount(t1) - 1);
      expect(t2).toContain("review: declined");
    });

    test("test: the record beside the engagement states why the gate declined, so a reader learns the threshold rather than guessing", async () => {
      const repo = declinedRun("run-md-declined-why");
      const out = await report(["run-md-declined-why", "--md"], repo);
      const t2 = out.slice(out.indexOf("## T2"));
      expect(t2).toMatch(/review: declined — .*complexity 1 < threshold 4/);
    });

    test("test: a declined gate does not make the task fail, so honesty in the record does not change what green means", async () => {
      const repo = declinedRun("run-md-declined-green");
      const out = await report(["run-md-declined-green", "--md"], repo);
      expect(out).toContain("**done:** 2");
      expect(out).toContain("**failed:** 0");
      expect(out).toContain("**gate failures:** none recorded");
      const t2 = out.slice(out.indexOf("## T2"));
      expect(t2).toContain("**opinion:** unqualified opinion");
      expect(t2).toContain("review: declined");
    });

    test("test: a gate that ran and passed is reported exactly as it is reported today", async () => {
      const repo = declinedRun("run-md-declined-pass");
      const out = await report(["run-md-declined-pass", "--md"], repo);
      expect(out).toContain("build: pass — exit 0");
      const t1 = out.slice(out.indexOf("## T1"), out.indexOf("## T2"));
      expect(t1).toContain("review: pass — reviewer claude-code:sonnet (anthropic): approved");
    });

    // T11: the Comparison section that `--md --compare` appends to the SAME record must not
    // count the declined gate either — `review: declined` and `gate pass rate 2/2` cannot coexist.
    test("the --compare gate pass rate never counts a gate that declined to run", async () => {
      const repo = declinedRun("run-md-declined-cmp");
      const baseline = Journal.create(repo, "run-md-cmp-base");
      baseline.append("run-start", undefined, { baseRef: "abc123def" });
      baseline.append("gate-result", "T1", { gate: "build", pass: true, details: "exit 0" });
      baseline.append("run-end", undefined, { done: ["T1"], failed: [], human: [] });

      const out = await report(["run-md-declined-cmp", "--md", "--compare", "run-md-cmp-base"], repo);
      expect(out).toContain("review: declined");
      // current run: build + review-ran passed, review-declined excluded → 2/2 ran gates passed…
      // declinedRun journals build+review for T1 and build+declined-review for T2 → 3 ran, 3 pass.
      expect(out).toContain("| gate pass rate | 1/1 | 3/3 |");
      expect(out).not.toContain("4/4");
    });
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
