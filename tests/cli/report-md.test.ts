import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { renderMarkdownRecord, report } from "../../src/cli/commands/report.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { modelProvider } from "../../src/route/preference.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const corpusDir = join(import.meta.dirname, "../fixtures/journal-corpus");
const corpusFiles = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".jsonl"))
  .sort();

function corpusCaseTitle(file: string): string {
  return `old-corpus sweep: ${file} renders --md without throwing`;
}

describe("tickmarkr report --md (REC-01 execution record)", () => {
  test("test: report renders a review row whose author and reviewer resolve to one true provider as pass same-provider independence not established and renders a review-leg2 journal row beside the daemon row it supersedes naming its reviewer and provider whereas a report that prints a bare pass for either fails", () => {
    const events: JournalEvent[] = [
      { ts: "2026-09-03T00:00:00.000Z", event: "run-start", data: { baseRef: "base" } },
      { ts: "2026-09-03T00:00:01.000Z", event: "task-dispatch", taskId: "T5", data: { assignment: { adapter: "pi", model: "openai-codex/gpt-5.5", channel: "sub", tier: "frontier" } } },
      { ts: "2026-09-03T00:00:02.000Z", event: "gate-result", taskId: "T5", data: { gate: "review", pass: true, details: "reviewer codex:gpt-5.6-sol (vendor: openai; provider: openai): approved" } },
      { ts: "2026-09-03T00:00:03.000Z", event: "review-leg2", taskId: "T5", data: { pass: true, reviewer: "kimi:kimi-code/k3", vendor: "moonshot", provider: "moonshot", details: "approved" } },
      { ts: "2026-09-03T00:00:04.000Z", event: "task-done", taskId: "T5", data: {} },
      { ts: "2026-09-03T00:00:05.000Z", event: "run-end", data: { done: ["T5"], failed: [], human: [] } },
    ];
    const out = renderMarkdownRecord("run-provider-review", events);
    expect(out).toContain("review: pass (same-provider — independence not established) — reviewer codex:gpt-5.6-sol");
    // CG1: a leg2 row with no validated owed-check discharge of its own claims no supersession.
    expect(out).toContain("review-leg2: pass (unvalidated — no validated owed-check discharge; the daemon review stands) — reviewer kimi:kimi-code/k3 (vendor: moonshot; provider: moonshot)");
  });

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

  // T4: a run is green only when run-end exists AND its tipVerify is not failed. The record now
  // states which of the three verification states the run reached, and names a cached verify —
  // a verified green of an EARLIER tip — instead of folding it into a plain pass.
  describe("verification state (tip-verify-before-green)", () => {
    // One task merged and done, and only the closing verdict differs between cases.
    const verifiedRun = (
      runId: string,
      close: { tipVerify?: "passed" | "failed"; cached?: boolean; resumedCached?: boolean } = {},
    ): JournalEvent[] => {
      const events: JournalEvent[] = [];
      const append = (event: string, taskId: string | undefined, data: Record<string, unknown>) => {
        events.push({
          ts: new Date(Date.parse("2026-08-07T00:00:00.000Z") + events.length * 1_000).toISOString(),
          event,
          ...(taskId === undefined ? {} : { taskId }),
          data,
        });
      };
      append("run-start", undefined, { baseRef: "abc123def", pid: 1 });
      append("task-dispatch", "T1", {
        assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" },
        attempt: 0,
      });
      append("gate-result", "T1", { gate: "build", pass: true, details: "exit 0" });
      append("task-done", "T1", { attempts: 1 });
      append("merge", "T1", { branch: `tickmarkr/${runId}`, commit: "deadbeef" });
      if (close.tipVerify !== undefined) {
        append("tip-verify-start", undefined, { tip: "cafe1234", gates: ["test"], cached: close.cached === true });
        if (close.cached) {
          append("tip-verify-cached", undefined, { tip: "cafe1234", gates: ["test"] });
          append("tip-verify", undefined, { gate: "test", pass: true, exitCode: 0, cached: true, tip: "cafe1234" });
        } else if (close.tipVerify === "failed") {
          append("tip-verify-failed", undefined, { gate: "test", exitCode: 1, tip: "cafe1234" });
        } else {
          append("tip-verify", undefined, { gate: "test", pass: true, exitCode: 0, tip: "cafe1234" });
        }
      }
      append("run-end", undefined, {
        runId,
        branch: `tickmarkr/${runId}`,
        done: ["T1"],
        failed: [],
        human: [],
        ...(close.tipVerify === undefined ? {} : { tipVerify: close.tipVerify }),
      });
      // A resume that re-verified an unmoved tip and has not closed yet: these events belong to a
      // cycle no run-end has judged, so nothing they say may reach the record's reading.
      if (close.resumedCached) {
        append("run-resume", undefined, { pid: 2 });
        append("tip-verify-start", undefined, { tip: "cafe1234", gates: ["test"], cached: true });
        append("tip-verify-cached", undefined, { tip: "cafe1234", gates: ["test"] });
        append("tip-verify", undefined, { gate: "test", pass: true, exitCode: 0, cached: true, tip: "cafe1234" });
      }
      return events;
    };

    const verificationLine = (out: string): string =>
      out.split("\n").find((line) => line.startsWith("- **verification:**")) ?? "";

    test("test: a run whose run-end carries tipVerify failed produces a report stating the run did not verify, and that report never describes the run as green", () => {
      const out = renderMarkdownRecord(
        "run-md-tip-failed",
        verifiedRun("run-md-tip-failed", { tipVerify: "failed" }),
      );
      // Every task landed — the record must still refuse to read as a verified run.
      expect(out).toContain("**done:** 1");
      expect(verificationLine(out)).toContain("FAILED");
      expect(verificationLine(out)).toContain("did not verify");
      expect(out).not.toMatch(/green/i);
    });

    test("test: a run whose run-end carries no tipVerify field produces a report naming verification as absent, distinct from both passed and failed", () => {
      const absent = verificationLine(renderMarkdownRecord("run-md-tip-absent", verifiedRun("run-md-tip-absent")));
      const passed = verificationLine(renderMarkdownRecord(
        "run-md-tip-passed",
        verifiedRun("run-md-tip-passed", { tipVerify: "passed" }),
      ));
      const failed = verificationLine(renderMarkdownRecord(
        "run-md-tip-red",
        verifiedRun("run-md-tip-red", { tipVerify: "failed" }),
      ));
      expect(absent).not.toBe(passed);
      expect(absent).not.toBe(failed);
      // An unrecorded verification is not a zero to invent: it claims neither verdict.
      expect(absent).toMatch(/verification:\*\* absent/);
      expect(passed).toMatch(/verification:\*\* passed/);
      expect(failed).toMatch(/verification:\*\* FAILED/);
    });

    test("test: a run verified from cache produces a report that says the verify was cached rather than reporting a plain pass", () => {
      const cached = verificationLine(renderMarkdownRecord(
        "run-md-tip-cached",
        verifiedRun("run-md-tip-cached", { tipVerify: "passed", cached: true }),
      ));
      const passed = verificationLine(renderMarkdownRecord(
        "run-md-tip-fresh",
        verifiedRun("run-md-tip-fresh", { tipVerify: "passed" }),
      ));
      expect(cached).toContain("cached");
      expect(cached).not.toBe(passed);
      expect(passed).toContain("passed");
      expect(passed).not.toContain("cached");
      // Provenance is read from the closed cycle, the same events the cockpit judged: a resumed
      // cached verify appended AFTER the final run-end has been closed by nothing, so it cannot
      // relabel the fresh pass that run-end does speak for.
      const resumed = verificationLine(renderMarkdownRecord(
        "run-md-tip-resumed",
        verifiedRun("run-md-tip-resumed", { tipVerify: "passed", resumedCached: true }),
      ));
      expect(resumed).toBe(passed);
      expect(resumed).not.toContain("cached");
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

// OBS-1201 / OBS-634: lineage and suite telemetry print what was measured and name what was not.
describe("OBS-1201 evidence lineage and OBS-634 suite telemetry", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-28T00:00:00.000Z") + s * 1_000).toISOString();
  const seed = (repo: string, runId: string, events: JournalEvent[], baseline?: unknown) => {
    const j = Journal.create(repo, runId);
    writeFileSync(join(j.dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (baseline !== undefined) writeFileSync(join(j.dir, "baseline.json"), JSON.stringify(baseline));
  };
  const testEntry = (entry: Record<string, unknown>) => ({ commands: { test: { exitCode: 0, fingerprints: [], ...entry } } });

  test("production reports expose fresh invocation replay reuse counts alongside measured suite-wall file-sum parallelism longest-file values versus unknown interrupted unmatched legacy history, so reused evidence counted fresh or unknown printed zero fails", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    // Measured: one fresh suite, its journal replay and a cache reuse — both copies carry the duration.
    seed(repo, "run-measured", [
      { ts: t(0), event: "run-start", data: { baseRef: "base" } },
      { ts: t(0), event: "task-dispatch", taskId: "T1", data: { attempt: 0 } },
      { ts: t(0), event: "worker-launch", taskId: "T1", data: { attempt: 0 } },
      { ts: t(10), event: "worker-result", taskId: "T1", data: { ok: true } },
      { ts: t(40), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 30_000, nonce: "n1" } },
      { ts: t(50), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, replayedFromAttempt: 0, durationMs: 30_000, nonce: "n1" } },
      { ts: t(55), event: "gate-result", taskId: "T2", data: { gate: "test", pass: true, reused: true, durationMs: 30_000, evidenceReceipt: { invocationId: "n1" } } },
      { ts: t(60), event: "run-end", data: { done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [] } },
    ], testEntry({
      durationMs: 600_000, fileDurationSumMs: 1_800_000, impliedParallelism: 3, fileCount: 12,
      longestFile: { file: "tests/slow.test.ts", durationMs: 240_000 },
    }));
    const suite = "wall 10m 0s · file-sum 30m 0s · implied parallelism 3.00 · longest file tests/slow.test.ts 4m 0s · 12 files";
    const md = await report(["run-measured", "--md"], repo);
    expect(md).toContain("- **gate evidence:** fresh 1 · replay 1 · reuse 1 · unknown 0");
    expect(md).toContain("- **test:** 30s (50%) · task-time 30s"); // the copies add no service
    expect(md).toContain(`- **suite telemetry (baseline test capture):** ${suite}`);
    const text = await report(["run-measured"], repo);
    expect(text).toContain("fresh 1 · replay 1 · reuse 1 · unknown 0");
    expect(text).toContain(suite);

    // A held screen ran fresh and its full suite came from the cache: the one merge-candidate row is
    // a reuse AND a fresh screen whose measured interval is test service. Its replayed copy and a bare
    // reuse add no time.
    seed(repo, "run-screen", [
      { ts: t(0), event: "run-start", data: { baseRef: "base" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gates" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(10), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(12), event: "gate-result", taskId: "T1", data: {
        gate: "test", pass: true, reused: true, fullSuite: true, durationMs: 6_000, selectedDurationMs: 6_000, fullDurationMs: 0,
        evidenceReceipt: { invocationId: "n-cached" },
      } },
      { ts: t(14), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, reused: true, fullSuite: true, replayedFromAttempt: 0, selectedDurationMs: 6_000 } },
      { ts: t(15), event: "gate-result", taskId: "T2", data: { gate: "test", pass: true, reused: true, evidenceReceipt: { invocationId: "n-cached" } } },
      { ts: t(20), event: "run-end", data: { done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [] } },
    ]);
    const screened = await report(["run-screen", "--md"], repo);
    expect(screened).toContain("- **test:** 6s (30%) · task-time 6s");
    expect(screened).toContain("- **gate evidence:** fresh 1 · replay 0 · reuse 3 · unknown 0");

    // Legacy and cut history: rows without durations, a dispatch with no launch row, a launch, a wait
    // and a gate start cut by a restart, a launch, a wait and a gate start never matched — and no
    // baseline capture at all.
    seed(repo, "run-legacy", [
      { ts: t(0), event: "run-start", data: { baseRef: "base" } },
      { ts: t(0), event: "task-dispatch", taskId: "T1", data: { attempt: 0 } },
      { ts: t(1), event: "worker-launch", taskId: "T1", data: { attempt: 0 } },
      { ts: t(2), event: "suite-wait", taskId: "T1", data: { count: 1 } },
      { ts: t(3), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(5), event: "run-resume", data: {} },
      { ts: t(6), event: "worker-launch", taskId: "T2", data: { attempt: 0 } },
      { ts: t(7), event: "suite-wait", taskId: "T2", data: { count: 1 } },
      { ts: t(8), event: "task-dispatch", taskId: "T3", data: { attempt: 0 } },
      { ts: t(8), event: "gate-result", taskId: "T1", data: { gate: "build", pass: true, details: "exit 0" } },
      { ts: t(9), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, details: "ok" } },
      { ts: t(9), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
      { ts: t(10), event: "run-end", data: { done: ["T1"], failed: [], human: [], blocked: [], pending: [] } },
    ]);
    const legacy = await report(["run-legacy", "--md"], repo);
    expect(legacy).toContain("- **interruption:** 2s (20%) · task-time 2s");
    expect(legacy).toContain("- **test:** unknown — 1 row without a duration · 1 cut by a restart\n");
    expect(legacy).toContain("- **semantics:** unknown — 1 unmatched\n");
    expect(legacy).toContain("- **other-gate:** unknown — 1 row without a duration");
    expect(legacy).toContain("- **worker:** unknown — 1 dispatch without a launch row · 1 unmatched · 1 cut by a restart");
    expect(legacy).toContain("- **queue:** unknown — 1 unmatched · 1 cut by a restart");
    expect(legacy).toContain("- **gate evidence:** fresh 0 · replay 0 · reuse 0 · unknown 2");
    expect(legacy).toContain("- **suite telemetry (baseline test capture):** not recorded — this run's baseline holds no test capture");
    expect(legacy).not.toMatch(/\*\*(?:test|semantics|worker|queue|other-gate):\*\* 0s/u);

    // A capture that returned no verdict, and one whose runner named no per-file timing.
    seed(repo, "run-infra", [{ ts: t(0), event: "run-start", data: {} }, { ts: t(1), event: "run-end", data: {} }],
      testEntry({ infra: true, invalidCause: "ceiling-kill", durationMs: 1_800_000, fileDurationSumMs: null, impliedParallelism: null, longestFile: null }));
    expect(await report(["run-infra", "--md"], repo))
      .toContain("- **suite telemetry (baseline test capture):** not measurable — the baseline capture returned no verdict (ceiling-kill)");
    seed(repo, "run-no-files", [{ ts: t(0), event: "run-start", data: {} }, { ts: t(1), event: "run-end", data: {} }],
      testEntry({ durationMs: 5_000, fileDurationSumMs: null, impliedParallelism: null, longestFile: null }));
    const unmeasured = "not measurable (the runner named no per-file durations)";
    expect(await report(["run-no-files", "--md"], repo)).toContain(
      `- **suite telemetry (baseline test capture):** wall 5s · file-sum ${unmeasured} · implied parallelism ${unmeasured} · longest file ${unmeasured}`,
    );

    // No run-start: no window to partition, said as such rather than a table of zeros.
    seed(repo, "run-no-start", [{ ts: t(0), event: "task-dispatch", taskId: "T1", data: {} }]);
    const noStart = await report(["run-no-start", "--md"], repo);
    expect(noStart).toContain("- **window:** not measurable — the journal names no run-start with a readable timestamp");
    expect(noStart).not.toContain("- **test:**");
  });
});

// CG1 (v2.6.4): the lead's end-to-end first pass is folded from THIS journal's lineage, and a leg2
// row's supersession is claimed only through its own validated owed-check discharge.
describe("CG1 end-to-end first pass and leg2 attribution", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-29T00:00:00.000Z") + s * 1_000).toISOString();
  const graphOf = (ids: string[]) => validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["cg1"], hash: "cg1" },
    tasks: ids.map((id) => ({ id, title: `task ${id}`, goal: `task ${id}`, shape: "implement", complexity: 3, acceptance: ["a"], status: "done" })),
  });
  const assignment = { adapter: "codex", model: "gpt-6-sol", channel: "sub", tier: "frontier" };
  /** A journal builder: every row's ts is its index, and push returns the row's physical-line binding. */
  const builder = () => {
    const rows: JournalEvent[] = [];
    const push = (event: string, taskId: string | undefined, data: Record<string, unknown> = {}) => {
      rows.push({ ts: t(rows.length), event, ...(taskId ? { taskId } : {}), data });
      return { line: rows.length, ts: rows.at(-1)!.ts };
    };
    return { rows, push };
  };
  const seed = (runId: string, ids: string[], rows: JournalEvent[]) => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, graphOf(ids));
    const j = Journal.create(repo, runId);
    writeFileSync(join(j.dir, "journal.jsonl"), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return { repo, j };
  };
  const lead = async (repo: string, runId: string) => ({
    md: (await report([runId, "--md"], repo)).split("\n"),
    text: (await report([runId], repo)).split("\n"),
    status: (await status([runId], repo)).split("\n"),
  });

  test("report and status render end-to-end first pass as zero successes from one park approve resume merge versus one success from one uninterrupted dispatch; missing predecessor or dispatch lineage reads unknown", async () => {
    const run = (runId: string, build: (push: ReturnType<typeof builder>["push"]) => void, start: Record<string, unknown> = {}) => {
      const { rows, push } = builder();
      push("run-start", undefined, { baseRef: "base", graphDefinitionHash: graphDefinitionHash(graphOf(["T1"])), ...start });
      build(push);
      push("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });
      return seed(runId, ["T1"], rows);
    };
    const parked = run("run-fp-parked", (push) => {
      push("task-dispatch", "T1", { assignment, attempt: 0, workerDispatchOrdinal: 0 });
      push("gate-result", "T1", { gate: "test", pass: false, details: "1 failed" });
      const park = push("task-human", "T1", { kind: "gate-fail" });
      push("task-approved", "T1", { by: "operator", release: "gate-satisfied", gate: "test", park });
      push("run-resume", undefined, { pid: 2 });
      push("task-done", "T1");
      push("merge", "T1", { commit: "d".repeat(40) });
    });
    // The engagement-local telemetry reads this task as a first-attempt success — the false-clean case.
    parked.j.telemetry({ taskId: "T1", shape: "implement", adapter: "codex", model: "gpt-6-sol", channel: "sub", attempts: 1, outcome: "done", durationMs: 1, firstAttemptOk: true });
    const clean = run("run-fp-clean", (push) => {
      push("task-dispatch", "T1", { assignment, attempt: 0, workerDispatchOrdinal: 0 });
      push("gate-result", "T1", { gate: "test", pass: true });
      push("task-done", "T1");
      push("merge", "T1", { commit: "e".repeat(40) });
    });
    // The task rows alone read one clean dispatch at attempt 0 straight to its merge; the run rows do not:
    // a run-end summary parked it and the run restarted before the merge.
    const summaryParked = run("run-fp-summary-park", (push) => {
      push("task-dispatch", "T1", { assignment, attempt: 0, workerDispatchOrdinal: 0 });
      push("run-end", undefined, { done: [], failed: [], human: ["T1"], blocked: [], pending: [] });
      push("run-resume", undefined, { pid: 2 });
      push("task-done", "T1");
      push("merge", "T1", { commit: "c".repeat(40) });
    });
    const restarted = run("run-fp-restarted", (push) => {
      push("task-dispatch", "T1", { assignment, attempt: 0, workerDispatchOrdinal: 0 });
      push("run-resume", undefined, { pid: 2 });
      push("task-done", "T1");
      push("merge", "T1", { commit: "9".repeat(40) });
    });
    const noDispatch = run("run-fp-no-dispatch", (push) => {
      push("task-done", "T1");
      push("merge", "T1", { commit: "f".repeat(40) });
    });
    const superseding = run("run-fp-supersedes", (push) => {
      push("task-dispatch", "T1", { assignment, attempt: 0, workerDispatchOrdinal: 0 });
      push("task-done", "T1");
      push("merge", "T1", { commit: "a".repeat(40) });
    }, { supersedes: "run-fp-old" });
    // A park, approval, resume and merge whose dispatch is missing, or read in a run continuing an unread
    // predecessor, has lost its lineage: unknown, never a known miss.
    const parkedLineage = (push: ReturnType<typeof builder>["push"], dispatch: boolean) => {
      if (dispatch) push("task-dispatch", "T1", { assignment, attempt: 0, workerDispatchOrdinal: 0 });
      push("gate-result", "T1", { gate: "test", pass: false, details: "1 failed" });
      const park = push("task-human", "T1", { kind: "gate-fail" });
      push("task-approved", "T1", { by: "operator", release: "gate-satisfied", gate: "test", park });
      push("run-resume", undefined, { pid: 2 });
      push("task-done", "T1");
      push("merge", "T1", { commit: "7".repeat(40) });
    };
    const parkedNoDispatch = run("run-fp-parked-no-dispatch", (push) => parkedLineage(push, false));
    const parkedSuperseding = run("run-fp-parked-supersedes", (push) => parkedLineage(push, true), { supersedes: "run-fp-old" });
    // The same park, approval, resume and merge — or one clean dispatch to its merge — whose first recorded
    // dispatch cannot prove it was the task's first: past attempt 0, a lifetime ordinal past 0 (attempts
    // reset at every release, the ordinal never does), or no recorded ordinal at all. The initial dispatch
    // is missing or unproven, so neither the interruption nor the clean merge is classified.
    const origins: Array<[string, Record<string, unknown>]> = [
      ["attempt-1", { attempt: 1, workerDispatchOrdinal: 0 }],
      ["ordinal-1", { attempt: 0, workerDispatchOrdinal: 1 }],
      ["ordinal-unrecorded", { attempt: 0 }],
    ];
    const unproven = origins.flatMap(([name, origin]) => [
      [run(`run-fp-parked-${name}`, (push) => {
        push("task-dispatch", "T1", { assignment, ...origin });
        push("gate-result", "T1", { gate: "test", pass: false, details: "1 failed" });
        const park = push("task-human", "T1", { kind: "gate-fail" });
        push("task-approved", "T1", { by: "operator", release: "gate-satisfied", gate: "test", park });
        push("run-resume", undefined, { pid: 2 });
        push("task-done", "T1");
        push("merge", "T1", { commit: "6".repeat(40) });
      }), `run-fp-parked-${name}`, "end-to-end first pass unknown (1 without lineage)"] as [{ repo: string }, string, string],
      [run(`run-fp-${name}`, (push) => {
        push("task-dispatch", "T1", { assignment, ...origin });
        push("task-done", "T1");
        push("merge", "T1", { commit: "b".repeat(40) });
      }), `run-fp-${name}`, "end-to-end first pass unknown (1 without lineage)"] as [{ repo: string }, string, string],
    ]);

    const cases: Array<[{ repo: string }, string, string]> = [
      [parked, "run-fp-parked", "end-to-end first pass 0/1"],
      [clean, "run-fp-clean", "end-to-end first pass 1/1"],
      [summaryParked, "run-fp-summary-park", "end-to-end first pass 0/1"],
      [restarted, "run-fp-restarted", "end-to-end first pass 0/1"],
      [noDispatch, "run-fp-no-dispatch", "end-to-end first pass unknown (1 without lineage)"],
      [superseding, "run-fp-supersedes", "end-to-end first pass unknown (1 without lineage)"],
      [parkedNoDispatch, "run-fp-parked-no-dispatch", "end-to-end first pass unknown (1 without lineage)"],
      [parkedSuperseding, "run-fp-parked-supersedes", "end-to-end first pass unknown (1 without lineage)"],
      ...unproven,
    ];
    for (const [{ repo }, runId, reading] of cases) {
      const out = await lead(repo, runId);
      expect(out.text[0], runId).toContain(reading);
      expect(out.md[0], runId).toContain(reading);
      expect(out.status[0], runId).toContain(reading);
      // The one-line form carries the same lineage reading — an unknown one included.
      expect(await status([runId, "--oneline"], repo), runId).toContain(` · ${reading} · `);
      expect(out.md, runId).toContain(`- **end-to-end first pass:** ${reading.replace("end-to-end first pass ", "")} — this journal's dispatch, park, approval and merge lineage`);
    }
    // At 80 columns the unknown reading moves to a continuation row after the three lead lines, never above them.
    const cols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });
    try {
      const narrow = (await status(["run-fp-no-dispatch"], noDispatch.repo)).split("\n");
      expect(narrow.slice(0, 3).map((line) => line.split(" ")[0])).toEqual(["finished", "time", "needs"]);
      expect(narrow[3]).toBe("  finished: end-to-end first pass unknown (1 without lineage)");
      // Report text wraps the same way: needs you stays the third line, EVERY row of the complete output
      // fits — the telemetry heading and the wall window included — and no fact is dropped.
      const text = (await report(["run-fp-no-dispatch"], noDispatch.repo)).split("\n");
      expect(text.slice(0, 3).map((line) => line.split(" ")[0])).toEqual(["finished", "time", "needs"]);
      expect(text[3]).toBe("  finished: end-to-end first pass unknown (1 without lineage)");
      expect(text[4]).toBe("tickmarkr engagement — run-fp-no-dispatch");
      for (const line of text) expect(cellWidth(line), line).toBeLessThanOrEqual(80);
      const joined = text.join(" ").replace(/\s+/gu, " ");
      expect(joined).toContain("engagement summary — audit trail: engagement-local telemetry, attempts restart at every resume");
      expect(joined).toMatch(/window \S+ — each instant counted once, by priority [^\n]*; task-time sums concurrent spans/u);
    } finally {
      if (cols) Object.defineProperty(process.stdout, "columns", cols);
      else delete (process.stdout as { columns?: number }).columns;
    }
    const parkedMd = (await lead(parked.repo, "run-fp-parked")).md;
    expect(parkedMd).toContain("- **first-attempt rate (engagement-local telemetry):** 1/1 (100%) — attempts restart at every resume");
  });

  test("report labels engagement-local telemetry separately and attributes a leg2 supersession only to its validated matching discharge while refused wrong-task wrong-gate and unavailable-artifact records remain unvalidated", async () => {
    const reviewer = { key: "claude-code:claude-opus-5-5", vendor: "anthropic" };
    const author = { key: "codex:gpt-6-sol", vendor: "openai" };
    const provider = modelProvider("claude-opus-5-5", "anthropic");
    const { rows, push } = builder();
    push("run-start", undefined, { baseRef: "base", graphDefinitionHash: graphDefinitionHash(graphOf(["T1", "T2", "T3", "T4"])) });
    const obligation = (taskId: string, gate: string, digit: string) => ({
      version: 1, id: `owed-${taskId}-${gate}`, runId: "run-leg2", taskId, gate, base: digit.repeat(40), head: digit.repeat(39) + "f",
      subject: `subject-${taskId}`, patch: `patch-${taskId}`, patches: [`patch-${taskId}`], criteria: `criteria-${taskId}`, files: ["src/a.ts"],
      authors: [author.key], declared: [author, reviewer], cause: "operator waive", evidence: "tickmarkr verify --record run-leg2",
      disposition: "accepted-risk", known: true,
    });
    const obligations = { T1: obligation("T1", "review", "1"), T3: obligation("T3", "test", "3"), T4: obligation("T4", "review", "4") };
    for (const [taskId, o] of Object.entries(obligations)) {
      push("task-dispatch", taskId, { assignment, attempt: 0, workerDispatchOrdinal: 0 });
      push("gate-result", taskId, { gate: o.gate, pass: false, details: `${o.gate} red` });
      const park = push("task-human", taskId, { kind: "gate-fail" });
      push("task-approved", taskId, { by: "operator", release: "gate-satisfied", gate: o.gate, park, obligation: o });
      push("task-done", taskId);
      push("merge", taskId, { commit: o.head });
    }
    push("task-dispatch", "T2", { assignment, attempt: 0, workerDispatchOrdinal: 0 });
    push("gate-result", "T2", { gate: "review", pass: true, reviewer: reviewer.key, details: "reviewer claude-code:claude-opus-5-5 (anthropic): approved" });
    push("task-done", "T2");
    push("merge", "T2", { commit: "2".repeat(40) });
    push("run-end", undefined, { done: ["T1", "T2", "T3", "T4"], failed: [], human: [], blocked: [], pending: [] });
    const { repo, j } = seed("run-leg2", ["T1", "T2", "T3", "T4"], rows);

    // verify --record after run-end: one hash-bound artifact per record, a discharge the fold accepts, then the leg2 row.
    const reviewRow = { gate: "review", pass: true, meta: { reviewer: reviewer.key, vendor: reviewer.vendor, provider } };
    const record = (taskId: string, o: typeof obligations.T1, gateRows: unknown[], leg2Task = taskId) => {
      const artifactPath = join(j.dir, `verify-${taskId}.json`);
      const bytes = Buffer.from(JSON.stringify({ base: o.base, head: o.head, mergeBase: o.base, green: true, files: o.files, criteria: o.criteria, gateRows }));
      writeFileSync(artifactPath, bytes);
      const bound = { mergeBase: o.base, head: o.head, artifactPath, artifactSha256: createHash("sha256").update(bytes).digest("hex") };
      push("owed-check-discharged", taskId, { ids: [o.id], gates: [o.gate], mapping: "exact", criteria: o.criteria, ...bound, reviewer, authorChannels: [author] });
      push("review-leg2", leg2Task, { base: o.base, author: author.key, artifactAvailability: "available", pass: true, reviewer: reviewer.key, vendor: reviewer.vendor, provider, details: "approved", ...bound });
      return artifactPath;
    };
    record("T1", obligations.T1, [reviewRow]);
    const t1Leg2 = rows.at(-1)!;
    // wrong task: T2's leg2 row carries T1's validated proof, which discharged T1's check, not T2's.
    rows.push({ ...t1Leg2, ts: t(rows.length), taskId: "T2" });
    // Same task, artifact and range as T1's proof, but not its own: a failed capture-failed row and a
    // passing row, each naming the author as reviewer, never borrow the sibling's validated discharge.
    const authorSeat = { reviewer: author.key, vendor: author.vendor, provider: modelProvider("gpt-6-sol", "openai") };
    rows.push({ ...t1Leg2, ts: t(rows.length), data: { ...t1Leg2.data, ...authorSeat, pass: false, artifactAvailability: "capture-failed" } });
    rows.push({ ...t1Leg2, ts: t(rows.length), data: { ...t1Leg2.data, ...authorSeat } });
    // wrong gate: T3's proof validly discharges a TEST check; its review row supersedes no review.
    record("T3", obligations.T3, [{ gate: "test", pass: true }, reviewRow]);
    const unavailable = record("T4", obligations.T4, [reviewRow]);
    writeFileSync(join(j.dir, "journal.jsonl"), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const leg2 = (md: string, taskId: string) =>
      md.split("\n## ").find((section) => section.startsWith(`${taskId}\n`))!.split("\n").filter((line) => line.includes("review-leg2:"));
    const supersedes = (id: string) => `review-leg2: pass (supersedes daemon review — validated discharge ${id}) — reviewer ${reviewer.key}`;
    const unvalidated = `review-leg2: pass (unvalidated — no validated owed-check discharge; the daemon review stands) — reviewer ${reviewer.key}`;

    const md = await report(["run-leg2", "--md"], repo);
    const authorText = `reviewer ${author.key} (vendor: openai; provider: ${authorSeat.provider})`;
    expect(leg2(md, "T1")).toEqual([
      `  - ${supersedes("owed-T1-review")} (vendor: anthropic; provider: ${provider})`,
      `  - review-leg2: fail (unvalidated — no validated owed-check discharge; the daemon review stands) — ${authorText}`,
      `  - review-leg2: pass (unvalidated — no validated owed-check discharge; the daemon review stands) — ${authorText}`,
    ]);
    expect(leg2(md, "T2")).toEqual([`  - ${unvalidated} (vendor: anthropic; provider: ${provider})`]);
    expect(leg2(md, "T3")).toEqual([`  - ${unvalidated} (vendor: anthropic; provider: ${provider})`]);
    expect(leg2(md, "T4")).toEqual([`  - ${supersedes("owed-T4-review")} (vendor: anthropic; provider: ${provider})`]);
    expect(md.split("\n")[2]).toBe("- needs you: outstanding 0 · 0 parked · 0 failed");

    // The artifact goes away: T4's proof no longer revalidates, so its row stops claiming supersession.
    rmSync(unavailable);
    const after = await report(["run-leg2", "--md"], repo);
    expect(leg2(after, "T1")).toEqual(leg2(md, "T1"));
    expect(leg2(after, "T4")).toEqual([`  - ${unvalidated} (vendor: anthropic; provider: ${provider})`]);
    expect(after.split("\n")[2]).toBe("- needs you: outstanding unknown · 0 parked · 0 failed · unknown: artifact unavailable");

    // A proof written BEFORE its obligation validates nothing: folded where it was written it names no recorded
    // obligation, so T1's leg2 row stops claiming supersession — moving it after the waive never lends it validity.
    const t1Proof = rows.findIndex((e) => e.event === "owed-check-discharged" && e.taskId === "T1");
    const t1Waive = rows.findIndex((e) => e.event === "task-approved" && e.taskId === "T1");
    const early = [...rows.slice(0, t1Waive), rows[t1Proof]!, ...rows.slice(t1Waive).filter((_, i) => i + t1Waive !== t1Proof)];
    // Every approval still binds its own park, at the physical line the move shifted it to.
    const rebound = early.map((e) => e.event === "task-approved" && e.data.park
      ? { ...e, data: { ...e.data, park: { ...(e.data.park as object), line: early.findIndex((p) => p.event === "task-human" && p.taskId === e.taskId) + 1 } } }
      : e);
    writeFileSync(join(j.dir, "journal.jsonl"), rebound.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const beforeObligation = await report(["run-leg2", "--md"], repo);
    expect(leg2(beforeObligation, "T1")[0]).toBe(`  - ${unvalidated} (vendor: anthropic; provider: ${provider})`);
    writeFileSync(join(j.dir, "journal.jsonl"), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");

    // The engagement-local telemetry is labelled apart from the lineage reading, on both report surfaces.
    expect(after).toContain("- **first-attempt rate (engagement-local telemetry):** not measurable — attempts restart at every resume");
    expect(after).toContain("- **end-to-end first pass:** 1/4 — this journal's dispatch, park, approval and merge lineage");
    expect(await report(["run-leg2"], repo)).toContain("engagement summary — audit trail: engagement-local telemetry, attempts restart at every resume");
  });
});
