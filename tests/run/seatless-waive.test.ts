// Queue row 418 (D-2187 add.84, add.100): a proven seatless review INFRA park admits a waive that merges
// and owes the review. Zero tokens: the fake adapter, a review seat returning no verdict, the real daemon,
// production approve, production verify --record and production status.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { approve, newestPark } from "../../src/cli/commands/approve.js";
import { status } from "../../src/cli/commands/status.js";
import { verify } from "../../src/cli/commands/verify.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { runDaemon } from "../../src/run/daemon.js";
import { decisionCommands, permittedDecisionVerbs } from "../../src/run/decision-verbs.js";
import { decisionEventsFromJournal } from "../../src/cli/commands/status.js";
import { deriveRunDecisions, previewDecision } from "../../src/tui/cockpit/decision-actions.js";
import { LISTING_INVOCATION_SUFFIX } from "../../src/run/recovery.js";
import { foldOwedChecks, Journal, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return [super.channels()[0]!, { ...super.channels()[1]!, tier: "cheap" }]; }
}
/** A cross-vendor seat that launches and answers with no verdict (no nonce): a real no-verdict review. */
class NoVerdictSeat extends FakeAdapter {
  calls = 0;
  constructor(path: string) { super(path); this.id = "review-seat"; this.vendor = "independent"; }
  override channels(): BillingChannel[] { return [{ adapter: this.id, model: "review-model", vendor: this.vendor, channel: "api", tier: "frontier" }]; }
  override headlessCommand(file: string): string {
    this.calls++;
    extractPromptNonce(readFileSync(file, "utf8"));
    return `printf '%s' ${shq(JSON.stringify({ approve: true, findings: [] }))}`;
  }
}

const NO_ACCEPTANCE = ["build", "test", "lint", "evidence", "scope", "review"];
const GATES = "gates: { build: \"true\", test: \"true\", lint: \"true\" }\n";
function fixture(taskId: string, gates = GATES, over: Record<string, unknown> = {}) {
  const f = setupRepo([T(taskId, { files: ["work.txt"], acceptance: [{ oracle: "command", command: "true" }], ...over })], {
    tasks: { [taskId]: [{ shell: `echo work > work.txt && ${COMMIT} work`, result: { ok: true, summary: "work" } }] },
  }, `routing:\n  deny:\n    workers:\n      adapters: [review-seat]\n${gates}`);
  const cfg = join(f.repo, ".tickmarkr", "config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
  writeDoctor(f.repo, {
    fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: authedModels(["fake-1", "fake-2"]) },
    "review-seat": { installed: true, authed: true, models: ["review-model"], modelAuth: authedModels(["review-model"]) },
  });
  return { ...f, author: new Author(f.scriptPath), seat: new NoVerdictSeat(f.scriptPath) };
}

const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const own = (all: JournalEvent[], taskId: string, event: string) => all.filter((e) => e.taskId === taskId && e.event === event);
const journalBytes = (repo: string, runId: string) => readFileSync(join(Journal.open(repo, runId).dir, "journal.jsonl"), "utf8");
/** The park notice's printed waive command, exactly as the daemon builds it from the just-journaled park. */
function printedWaive(repo: string, runId: string, taskId: string): string[] {
  const all = rows(repo, runId);
  const { commands } = decisionCommands(runId, taskId, newestPark(all, taskId));
  const waive = commands.find((c) => c.verb === "waive");
  expect(waive?.command, "printed waive").toContain("--gate review");
  return waive!.command.split(" ").slice(2);
}

afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; vi.restoreAllMocks(); });

describe("row 418 — the seatless review infra waive (production daemon, approve, verify, status)", { timeout: 300_000 }, () => {
  test("a real no verdict review infra park from the daemon admits the printed review waive command which merges and owes the review", async () => {
    for (const cause of ["no-verdict", "retired-only recovery", "acceptance disabled"] as const) {
      const taskId = "T5";
      const runId = `run-waive-${cause.split(" ")[0]}`;
      const f = cause === "acceptance disabled" ? fixture(taskId, GATES, { gates: NO_ACCEPTANCE }) : fixture(taskId);
      const adapters = [f.author, f.seat];
      expect((await runDaemon(f.repo, { runId, adapters })).human, cause).toEqual([taskId]);
      if (cause === "retired-only recovery") {
        await approve([runId, taskId, "--recheck"], f.repo);
        // a changed test command misses the verdict cache: the recheck EXECUTES its full suite (a reused verdict is no proof)
        const cfg = join(f.repo, ".tickmarkr", "config.yaml");
        writeFileSync(cfg, readFileSync(cfg, "utf8").replace('test: "true"', 'test: "true && true"'));
        expect((await runDaemon(f.repo, { runId, adapters, resume: true })).human, cause).toEqual([taskId]);
        expect(newestPark(rows(f.repo, runId), taskId)!.reason, cause).toContain("retired it");
      }
      let all = rows(f.repo, runId);
      const park = newestPark(all, taskId)!;
      // the park records its task's enabled gates, so every surface reads the one proof
      expect(own(all, taskId, "task-human").at(-1)!.data.enabledGates, cause)
        .toEqual(cause === "acceptance disabled" ? NO_ACCEPTANCE : ["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
      expect(park.kind, cause).toBe("infra");
      expect(park.failedGate, cause).toBe("review");
      expect(own(all, taskId, "gate-result").filter((e) => e.data.gate === "review").at(-1)!.data, cause)
        .toMatchObject({ noVerdict: true, infra: true, skipped: true });
      expect(park.reviewWaiveProof, cause).toMatchObject({ ok: true });
      expect(permittedDecisionVerbs(park), cause).toEqual(["approve", "waive", "recheck"]);
      // the park's own reason prints the waive too: one verb table, never a waive the reason hides
      expect(park.reason, cause).toMatch(/`tickmarkr approve \S+ T5 --waive`/);

      // status's decision event, the cockpit's decisions and its preview all offer the same waive
      const event = decisionEventsFromJournal(all, runId).filter((e) => e.type === "human-decision-required").at(-1) as { decisionCommands: { verb: string }[] };
      expect(event.decisionCommands.map((c) => c.verb), cause).toEqual(["approve", "waive", "recheck"]);
      expect(deriveRunDecisions(Journal.open(f.repo, runId)).find((d) => d.taskId === taskId)!.verbs, cause).toEqual(["approve", "waive", "recheck"]);
      expect(previewDecision({ verb: "waive", taskId, gate: "review", park: `${park.line}@${park.ts}` }, { cwd: f.repo, runId, by: "op" }).ok, cause).toBe(true);

      const out = await approve([...printedWaive(f.repo, runId, taskId), "--by", "op"], f.repo);
      expect(out, cause).toContain("waived failed gate review");
      all = rows(f.repo, runId);
      const waive = own(all, taskId, "task-approved").at(-1)!;
      expect(waive.data, cause).toMatchObject({ release: "gate-satisfied", gate: "review", obligation: { gate: "review", known: true } });

      const resumed = await runDaemon(f.repo, { runId, adapters, resume: true });
      expect(resumed.done, cause).toEqual([taskId]);
      all = rows(f.repo, runId);
      expect(own(all, taskId, "merge"), cause).toHaveLength(1);
      expect(foldOwedChecks(all, f.repo), cause).toMatchObject({ known: true, debt: 1, outstanding: [{ gate: "review", taskId }] });
    }
  });

  test("every refused proof case through production approve writes no approval row no merge and no debt", async () => {
    const refusedWaive = async (repo: string, runId: string, taskId: string, why: RegExp) => {
      const before = journalBytes(repo, runId);
      await expect(approve([runId, taskId, "--waive", "--gate", "review", "--by", "op"], repo)).rejects.toThrow(why);
      await expect(approve([runId, taskId, "--waive", "--by", "op"], repo)).rejects.toThrow(why);
      expect(journalBytes(repo, runId)).toBe(before); // no approval row: the proof is read before any write
      const all = rows(repo, runId);
      expect(own(all, taskId, "task-approved")).toEqual([]);
      expect(own(all, taskId, "merge")).toEqual([]);
      expect(foldOwedChecks(all, repo)).toMatchObject({ known: true, debt: 0, outstanding: [] });
      expect(permittedDecisionVerbs(newestPark(all, taskId))).toEqual(["approve", "recheck"]);
    };
    // no test command: the test row is a skipped no-command row, never an executed full suite
    {
      const f = fixture("T6", "gates: { build: \"true\", lint: \"true\" }\n");
      expect((await runDaemon(f.repo, { runId: "run-refuse-skipped", adapters: [f.author, f.seat] })).human).toEqual(["T6"]);
      expect(newestPark(rows(f.repo, "run-refuse-skipped"), "T6")!.reviewWaiveProof).toMatchObject({ ok: false, missing: "test" });
      await refusedWaive(f.repo, "run-refuse-skipped", "T6", /no executed full test passed/);
    }
    // Every T9 refusal cell on a REAL qualifying park: the daemon's journal is edited one cell at a time and
    // production approve must refuse before any write. Rows are T7's gate-results; `review` is the parked row.
    type Rows = JournalEvent[];
    const f = fixture("T7");
    const runId = "run-refuse-matrix";
    expect((await runDaemon(f.repo, { runId, adapters: [f.author, f.seat] })).human).toEqual(["T7"]);
    const path = join(Journal.open(f.repo, runId).dir, "journal.jsonl");
    const original = readFileSync(path, "utf8");
    const base = original.trimEnd().split("\n").map((line) => JSON.parse(line) as JournalEvent);
    expect(newestPark(base, "T7")!.reviewWaiveProof).toMatchObject({ ok: true }); // the control: unedited, it proves
    const isGate = (e: JournalEvent, gate: string) => e.event === "gate-result" && e.taskId === "T7" && e.data.gate === gate;
    const review = base.filter((e) => isGate(e, "review")).at(-1)!;
    const attempt = review.data.attempt as number;
    const edit = (gate: string, f2: (d: Record<string, unknown>) => Record<string, unknown> | undefined) => (rs: Rows): Rows =>
      rs.flatMap((e) => { if (!isGate(e, gate)) return [e]; const d = f2(e.data); return d ? [{ ...e, data: d }] : []; });
    /** A copy of the (first) test row, with `extra`, journaled right after it. */
    const after = (extra: Record<string, unknown>) => (rs: Rows): Rows => {
      const at = rs.findIndex((e) => isGate(e, "test"));
      return [...rs.slice(0, at + 1), { ...rs[at]!, data: { ...rs[at]!.data, ...extra } }, ...rs.slice(at + 1)];
    };
    const strip = ({ evidenceReceipt: _r, evidenceReceipts: _rs, ...data }: Record<string, unknown>) => data;
    const listing = { invocationId: `inv${LISTING_INVOCATION_SUFFIX}`, subject: { gate: "test" }, termination: { kind: "exit", exitCode: 0 } };
    const NO_TEST = /row 418: no executed full test passed/;
    const VERB = /--waive applies to a gate-fail park|refusing mismatched gate/;
    const cells: [string, (rs: Rows) => Rows, RegExp][] = [
      ["unexecuted test (no receipt)", edit("test", (d) => strip(d)), NO_TEST],
      ["listing-only receipts", edit("test", (d) => ({ ...strip(d), evidenceReceipt: listing, evidenceReceipts: [listing] })), NO_TEST],
      ["selected-screen-only proof", edit("test", (d) => ({ ...d, selectedTests: ["tests/a.test.ts"], fullSuite: undefined })), NO_TEST],
      ["owed test", edit("test", (d) => ({ ...d, testOwed: true })), NO_TEST],
      ["absent test", edit("test", () => undefined), NO_TEST],
      ["prior-attempt green, no current test", edit("test", (d) => ({ ...d, attempt: attempt - 1 })), NO_TEST],
      ["prior-attempt green followed by testOwed", (rs) => after({ attempt, testOwed: true, pass: undefined, evidenceReceipt: undefined, evidenceReceipts: undefined })(edit("test", (d) => ({ ...d, attempt: attempt - 1 }))(rs)), NO_TEST],
      ["mismatched subject token", edit("test", (d) => ({ ...d, commit: "0".repeat(40) })), NO_TEST],
      ["green followed by a later skipped test", after({ skipped: true, evidenceReceipt: undefined, evidenceReceipts: undefined }), /row 418: a later test row on the parked subject/],
      ["green followed by a later red test", after({ pass: false }), VERB],
      ["enabled acceptance red", edit("acceptance", (d) => ({ ...d, pass: false })), /row 418: acceptance did not pass|refusing mismatched gate|--waive applies/],
      ["enabled acceptance absent", edit("acceptance", () => undefined), /row 418: acceptance did not pass/],
      // a pass:false review on an infra park (stale proof, no no-verdict marker) is not the no-verdict row
      ["pass:false review without noVerdict", edit("review", ({ noVerdict: _n, ...d }) => ({ ...d, pass: false, staleProof: true })), VERB],
      // an infra park whose failed gate is not review refuses the waive as at the base
      ["infra park on another gate", edit("review", (d) => ({ ...d, gate: "acceptance" })), VERB],
    ];
    for (const [name, cell, why] of cells) {
      const edited = cell(base);
      writeFileSync(path, `${edited.map((e) => JSON.stringify(e)).join("\n")}\n`);
      const park = newestPark(rows(f.repo, runId), "T7")!;
      expect(park.kind, name).toBe("infra");
      expect(park.reviewWaiveProof?.ok, name).not.toBe(true);
      await refusedWaive(f.repo, runId, "T7", why).catch((e: Error) => { throw new Error(`${name}: ${e.message}`); });
    }
    writeFileSync(path, original);
  });

  test("verify record discharges the owed review of a waived infra park and status then reads outstanding zero", async () => {
    const f = fixture("T9");
    const runId = "run-waive-discharge";
    const adapters = [f.author, f.seat];
    expect((await runDaemon(f.repo, { runId, adapters })).human).toEqual(["T9"]);
    // the registered zero-token fake is a declared seat when the waive captures the obligation
    const script = join(makeTestTempDir("seatless-waive-script-"), "script.json");
    writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
    process.env.TICKMARKR_FAKE_SCRIPT = script;
    await approve([runId, "T9", "--waive", "--gate", "review", "--by", "op"], f.repo);
    expect((await runDaemon(f.repo, { runId, adapters, resume: true })).done).toEqual(["T9"]);
    let all = rows(f.repo, runId);
    const obligation = own(all, "T9", "task-approved").at(-1)!.data.obligation as { id: string; head: string };
    expect(foldOwedChecks(all, f.repo)).toMatchObject({ known: true, debt: 1, outstanding: [{ id: obligation.id }] });
    expect(JSON.parse(await status([runId, "--json"], f.repo)).verdict.outstanding).toMatchObject({ known: true, debt: 1 });

    // the owed review, re-run on the obligation's own range by a declared cross-vendor seat
    vi.spyOn(console, "error").mockImplementation(() => {});
    execFileSync("git", ["checkout", "-q", "--detach", obligation.head], { cwd: f.repo });
    const result = await verify(["--task", "T9", "--no-acceptance", "--record", runId], f.repo);
    expect(result.code, result.out).toBe(0);
    all = rows(f.repo, runId);
    expect(foldOwedChecks(all, f.repo)).toMatchObject({ known: true, debt: 0, outstanding: [], discharged: [obligation.id] });
    expect(await status([runId], f.repo)).toContain("outstanding 0");
  });
});
