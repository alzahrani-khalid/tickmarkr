import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, journaledFailureBrief, outstandingReviewFindings } from "../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

class Author extends FakeAdapter {
  judges = 0;
  override channels(): BillingChannel[] { return super.channels().slice(0, 1); }
  override headlessCommand(file: string, model: string): string {
    if (readFileSync(file, "utf8").startsWith("TICKMARKR-JUDGE")) this.judges++;
    return super.headlessCommand(file, model);
  }
}

class Seat extends FakeAdapter {
  calls: string[] = [];
  override harnessBannerRows = ["SEAT HARNESS"] as const;
  constructor(path: string, public override id: string, private mode: "silent" | "truncated" | "good", private tier: BillingChannel["tier"] = "frontier") {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    // RF-1: seats sit at the author's tier; api channels cost more than the author's sub seat so worker routing never picks them
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: this.tier }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    this.calls.push(/## Task ([^:]+):/.exec(prompt)?.[1] ?? "unknown");
    if (this.mode === "silent") return "printf 'SEAT HARNESS'; sleep 2";
    // The ceiling below is a BUDGET for the slowest runner (a single coverage-instrumented CI fork spawns
    // this shell in well over 100 ms — 2.5.1's first public CI killed the good seat as "silent" at 100 ms);
    // the truncated seat must still overrun it.
    if (this.mode === "truncated") return "printf 'Inspecting implementation'; sleep 2";
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)![1];
    return `printf '%s' ${shq(JSON.stringify({ nonce, approve: true, findings: [] }))}`;
  }
}

const config = `concurrency: 1
review: { required: true, prefer: [seat-a, seat-b, seat-c], timeoutMs: 1000 }
`;
const work = (id: string) => ({ shell: `echo work > ${id}.txt && ${COMMIT} work`, result: { ok: true, summary: "work" } });

describe("review infrastructure recovery", () => {
  test("test: a round whose review and its in-gate re-route both return no verdict beside a red judge re-runs the review alone on the next eligible seat and parks infra only when no seat remains, carrying the judge's findings and journaling no escalation, consult or repair-attempt row, so a run whose no-verdict review journals escalation step consult fails", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], {
      tasks: { T1: [work("T1")] },
      judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "src/work.ts:1 missing required behavior" }] },
    }, config);
    const author = new Author(scriptPath);
    const seats = ["seat-a", "seat-b", "seat-c"].map((id) => new Seat(scriptPath, id, "silent"));
    const result = await runDaemon(repo, { adapters: [author, ...seats], runId: "run-review-infra" });
    expect(result.human).toEqual(["T1"]);
    expect(seats.map((seat) => seat.calls)).toEqual([["T1"], ["T1"], ["T1"]]);
    expect(author.judges).toBe(1);
    const journal = Journal.open(repo, "run-review-infra");
    const rows = journal.read();
    expect(rows.filter((row) => row.event === "task-dispatch")).toHaveLength(1);
    expect(rows.filter((row) => ["escalation", "consult", "consult-verdict", "repair-attempt"].includes(row.event))).toEqual([]);
    expect(rows.find((row) => row.event === "task-human")?.data.kind).toBe("infra");
    const retried = rows.findIndex((row) => row.event === "review-infra-retry");
    expect(retried).toBeGreaterThan(rows.findIndex((row) => row.event === "review-retry"));
    expect(rows[retried]?.data.reviewer).toBe("seat-c:seat-c");
    const judge = rows.find((row) => row.event === "gate-result" && row.data.gate === "acceptance");
    expect(judge?.data.pass).toBe(false);
    expect(JSON.stringify(judge?.data.findings)).toContain("missing required behavior");
    const reviews = rows.filter((row) => row.event === "gate-result" && row.data.gate === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews.every((row) => row.data.infra === true && row.data.skipped === true && row.data.pass === undefined && row.data.findings === undefined)).toBe(true);
    // An infra row is not a passing review: a prior round's open blocking finding survives it.
    const finding = { gate: "review", pass: false, details: "requested changes", commit: "c", attempt: 0,
      findings: [{ class: "material", path: "src/work.ts", symbol: "work", note: "wrong", fingerprint: "f1" }] };
    const priorRed = { ...rows[0]!, event: "gate-result", taskId: "T1", data: finding };
    expect(outstandingReviewFindings([priorRed, ...reviews], "T1")).toHaveLength(1);
    expect(journaledFailureBrief(rows, "T1").join("\n")).toContain("missing required behavior");
    expect(journaledFailureBrief(rows, "T1").join("\n")).not.toContain("review:");
    const telemetry = readFileSync(`${journal.dir}/telemetry.jsonl`, "utf8");
    expect(telemetry.trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.outcome === "human"))
      .toMatchObject({ gateFails: 0, consults: 0 });
  });

  test("test: a review seat whose capture holds only harness rows to the ceiling is recorded cause silent and journaled demoted at that round, and a later task's review in the same run never seats it, while a seat that emitted prose before the ceiling is recorded truncated and stays seatable, so a zero-authored seat recorded truncated or re-seated fails", async () => {
    const { repo, scriptPath } = setupRepo([
      T("T1", { acceptance: [{ oracle: "command", command: "true" }] }),
      T("T2", { deps: ["T1"], acceptance: [{ oracle: "command", command: "true" }] }),
    ], { tasks: { T1: [work("T1")], T2: [work("T2")] } }, config);
    const author = new Author(scriptPath);
    const silent = new Seat(scriptPath, "seat-a", "silent");
    const truncated = new Seat(scriptPath, "seat-b", "truncated");
    const good = new Seat(scriptPath, "seat-c", "good");
    const result = await runDaemon(repo, { adapters: [author, silent, truncated, good], runId: "run-review-demotion" });
    expect(result.done).toEqual(["T1", "T2"]);
    expect(silent.calls).toEqual(["T1"]);
    expect(truncated.calls).toEqual(["T1", "T2"]);
    expect(good.calls).toEqual(["T1", "T2"]);
    const rows = Journal.open(repo, "run-review-demotion").read();
    const demotions = rows.filter((row) => row.event === "review-pool-demotion");
    expect(demotions).toHaveLength(1);
    expect(demotions[0]).toMatchObject({ taskId: "T1", data: { reviewer: "seat-a:seat-a", cause: "silent", seatAuthoredBytes: 0 } });
    expect(rows.indexOf(demotions[0]!)).toBeLessThan(rows.findIndex((row) => row.event === "review-retry"));
    expect(rows.filter((row) => row.event === "review-no-verdict" && row.data.reviewer === "seat-b:seat-b")
      .map((row) => row.data.cause)).toEqual(["truncated", "truncated"]);
  });

  // Leg-2 T4 M2 (RF-1): a frontier seat's no-verdict is journaled as `review-no-verdict` (with its dispatch
  // tier) BEFORE the in-gate retry publishes a gate-result. A daemon killed between the two leaves that row
  // as the task's only reviewer evidence; on resume it must hold the floor exactly like a review gate-result.
  test("test: on resume, a task whose only review evidence is a review-no-verdict row naming a frontier seat holds a frontier floor with cause prior-reviewer under a cheap author and review.floor worker, seating the frontier seat over the preferred mid seat, so a resume that seats mid after a journaled frontier no-verdict fails", async () => {
    // implement's default advisory floor is mid — lowered so the cheap fake channel authors and the mid seat stays a reviewer
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("T1")] } },
      `concurrency: 1\nrouting:\n  escalateTier: "off"\n  floors: { implement: cheap }\nreview: { required: true, prefer: [seat-b, seat-a], timeoutMs: 1000 }\n`);
    class CheapAuthor extends FakeAdapter {
      override channels(): BillingChannel[] { return [{ ...super.channels()[0]!, tier: "cheap" }]; }
    }
    const seatA = new Seat(scriptPath, "seat-a", "good", "frontier");
    const seatB = new Seat(scriptPath, "seat-b", "good", "mid");
    const runId = "run-noverdict-resume";
    const journal = Journal.create(repo, runId);
    journal.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    journal.append("review-no-verdict", "T1", { reviewer: "seat-a:seat-a", reviewerTier: "frontier", noVerdict: true, infra: true, cause: "empty-output", bytes: 0, seatAuthoredBytes: 0 });
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const result = await runDaemon(repo, { adapters: [new CheapAuthor(scriptPath), seatA, seatB], runId, resume: true });
    expect(result.done).toEqual(["T1"]);
    expect([seatA.calls, seatB.calls]).toEqual([["T1"], []]);
    const review = Journal.open(repo, runId).read().filter((row) => row.event === "gate-result" && row.data.gate === "review").at(-1)!;
    expect(review.data).toMatchObject({ reviewer: "seat-a:seat-a", reviewerTier: "frontier", reviewerFloor: "frontier", reviewerFloorCause: "prior-reviewer" });
  });
});
