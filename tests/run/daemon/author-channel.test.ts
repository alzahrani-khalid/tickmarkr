// OBS-1153: merged authors are their own fact beside the last dispatch, and preserved work keeps the
// attempt that produced it. Zero tokens: fake adapter, subprocess driver, scripted gates.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { channelKey, shq, type BillingChannel } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { status } from "../../../src/cli/commands/status.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../../src/drivers/types.js";
import { captureBaseline } from "../../../src/gates/baseline.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { PRESERVE_COMMIT_SUBJECT, preserveWorktree } from "../../../src/run/git.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { readOperatorState } from "../../../src/run/operator-state.js";
import { boardFrame } from "../../../src/tui/cockpit/board.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const of = (rows: JournalEvent[], event: string) => rows.filter((r) => r.event === event && r.taskId === "T1");

class ThirdReviewer extends FakeAdapter {
  override id = "third-review";
  override vendor = "third-vendor";
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const text = readFileSync(file, "utf8");
    const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
    return `printf '%s\\n' ${shq(JSON.stringify({ nonce: extractPromptNonce(text), approve: true, resolved: prior, reraised: [], findings: [] }))}`;
  }
}

function twoVendors(fake: FakeAdapter) {
  fake.channels = () => [
    { adapter: "fake", model: "fake-1", vendor: "openai", channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "anthropic", channel: "api", tier: "frontier" },
  ];
  return fake;
}

// Attempt A (fake:fake-1) left one commit in the task checkout; an upheld review funds attempt B
// (fake:fake-2). "legacy" makes A's commit an engine preserve commit named by a producer-less row.
async function authoredFixture(runId: string, shape: "a-only" | "mixed" | "legacy") {
  const made = setupRepo([T("T1", { files: ["work.txt", "fix.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })], {
    tasks: { T1: [{ shell: shape === "mixed" ? `echo fix > fix.txt && ${COMMIT} fix` : "test -f work.txt", result: { ok: true, summary: "repaired" } }] },
  }, "review: { required: false }\nrouting: { deny: { workers: { adapters: [third-review] } } }\n");
  twoVendors(made.fake);
  const baseRef = git(made.repo, "rev-parse", "HEAD");
  const branch = `tickmarkr/${runId}`;
  const wt = await new SubprocessDriver().worktree(made.repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "work.txt"), "original work\n");
  git(wt, "add", "work.txt");
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", shape === "legacy" ? PRESERVE_COMMIT_SUBJECT : "original"], { cwd: wt,
    env: { ...process.env, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" } });
  const journal = Journal.create(made.repo, runId);
  journal.append("run-start", undefined, { baseRef, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(made.repo)) });
  journal.append("task-dispatch", "T1", { attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
  if (shape === "legacy") {
    const ref = `refs/tickmarkr/preserved/${git(wt, "rev-parse", "HEAD")}`;
    git(wt, "update-ref", ref, "HEAD");
    journal.append("worktree-preserved", "T1", { ref }); // written before producers were recorded
  }
  journal.append("worker-result", "T1", { ok: true, summary: "original work", deviations: [] });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "request changes: work.txt needs correction" });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "review needs correction" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(await captureBaseline(made.repo, {})));
  await approve([runId, "T1", "--uphold", "--review-rounds", "1"], made.repo);
  const adapters = [made.fake, new ThirdReviewer(made.scriptPath)];
  const summary = await runDaemon(made.repo, { adapters, runId, resume: true });
  if (shape === "legacy") {
    // An unknown author leaves no provably cross-vendor reviewer: the review parks fail-closed for a waive.
    expect(summary.human).toEqual(["T1"]);
    await approve([runId, "T1", "--waive"], made.repo);
    expect((await runDaemon(made.repo, { adapters, runId, resume: true })).done).toEqual(["T1"]);
  } else expect(summary.done).toEqual(["T1"]);
  return { repo: made.repo, rows: journal.read() };
}

test("the production daemon projects authors=A last dispatch=B for A-only commits versus authors=A+B for mixed commits or unknown for legacy provenance consistently across task-done/status/board, so latest-dispatch authorship fails", async () => {
  const cases = [
    { runId: "run-authors-a-only", shape: "a-only", authors: ["fake:fake-1"], note: "authors fake:fake-1" },
    { runId: "run-authors-mixed", shape: "mixed", authors: ["fake:fake-1", "fake:fake-2"], note: "authors fake:fake-1+fake:fake-2" },
    { runId: "run-authors-legacy", shape: "legacy", authors: ["unknown"], note: "authors unknown" },
  ] as const;
  for (const c of cases) {
    const { repo, rows } = await authoredFixture(c.runId, c.shape);
    const done = of(rows, "task-done").at(-1)!;
    // task-done: the merged authors, beside B as the last-dispatched seat.
    expect(channelKey(done.data.assignment as never)).toBe("fake:fake-2");
    expect(of(rows, "task-dispatch").at(-1)?.data.assignment).toMatchObject({ model: "fake-2" });
    expect(done.data.authors).toEqual(c.authors);
    // operator fold / board: channel stays the last dispatch, authors are their own fact.
    const snapshot = readOperatorState({ events: rows, graph: loadGraph(repo) });
    const task = snapshot.tasks.find((t) => t.id === "T1")!;
    expect(task.channel).toBe("fake:fake-2");
    expect(task.authors).toEqual(c.authors);
    const board = boardFrame({ runId: c.runId, snapshot, graph: loadGraph(repo), now: Date.now(), colour: false }, 220);
    expect(board.rows.find((r) => r.id === "T1")!.note).toContain(c.note);
    // status: the same projection beside the last-dispatched channel.
    const printed = await status([c.runId], repo);
    const line = printed.split("\n").find((l) => l.includes("T1") && l.includes("fake:fake-2"))!;
    expect(line).toContain(c.note);
  }
}, 240_000);

/** Workers run normally until the third, whose wait throws after its shell finished → task-failed. */
const wedgedThirdWorker = (): ExecutorDriver => {
  const inner = new SubprocessDriver();
  let workers = 0;
  return {
    id: "wedged-third-worker",
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    async waitOutput(slot, pattern, timeoutMs, opts) {
      const seen = await inner.waitOutput(slot, pattern, timeoutMs, opts);
      if (slot.name.includes("-worker-") && ++workers === 3) throw new Error("pane wedged after the third worker");
      return seen;
    },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  } as ExecutorDriver;
};

test("the production daemon retains the known producing attempt of preserved work through refusal recreation and cherry-pick resume versus explicit unknown for an unattributed caller, so crediting an engine preserve commit to the next seat fails", async () => {
  // A (fake:fake-1, attempt 0) leaves its work uncommitted → dirty refusal → same-seat retry (attempt 1)
  // recreates the checkout → attempt 1 hits a quota wall → failover dispatches seat B (fake:fake-2),
  // whose pane wedges → task-failed. B is the last dispatch; only A ever wrote the rescued bytes.
  const { repo, fake } = setupRepo([T("T1", { files: ["rescue.txt"], gates: ["build", "test", "lint", "evidence", "scope"] })], {
    tasks: { T1: [
      { shell: "echo rescue > rescue.txt", result: { ok: true, summary: "left the rescue uncommitted" } },
      { shell: "echo 'usage limit reached for this model'; exit 1" }, // no trailer + quota text → channel failover
      { shell: "true", result: { ok: true, summary: "carried nothing" } },
    ] },
  });
  twoVendors(fake);
  const runId = "run-preserved-producer";
  expect((await runDaemon(repo, { adapters: [fake], runId, driver: wedgedThirdWorker() })).failed).toEqual(["T1"]);
  let rows = Journal.open(repo, runId).read();
  const dispatches = of(rows, "task-dispatch");
  const producerA = channelKey(dispatches[0]!.data.assignment as never);
  const seatB = channelKey(dispatches.at(-1)!.data.assignment as never);
  expect([producerA, seatB]).toEqual(["fake:fake-1", "fake:fake-2"]);
  expect(of(rows, "quota-failover")).toHaveLength(1);
  // The dirty refusal preserves A's bytes stamped with A's attempt, in the row and the commit trailer.
  const refusal = of(rows, "gate-result").find((r) => r.data.dirtyWorktree === true)!;
  expect(refusal.data).toMatchObject({ producer: producerA, producerAttempt: 0 });
  expect(git(repo, "log", "-1", "--format=%B", String(refusal.data.preservedRef))).toContain(`Tickmarkr-Producer: ${producerA} attempt 0`);
  // Refusal recreation runs after the retry's dispatch row (attempt 1), yet the preservation stays attempt 0's.
  const preservations = of(rows, "worktree-preserved");
  expect(preservations).toHaveLength(1);
  expect(rows.indexOf(dispatches[1]!)).toBeLessThan(rows.indexOf(preservations[0]!));
  expect(dispatches[1]!.data.attempt).toBe(1);
  expect(preservations[0]!.data).toMatchObject({ producer: producerA, producerAttempt: 0 });
  const preservedRef = String(preservations[0]!.data.ref);
  expect(git(repo, "log", "-1", "--format=%B", preservedRef)).toContain(`Tickmarkr-Producer: ${producerA} attempt 0`);

  // The held-probe park names its preserve ref as a bare {ref} with no producer; a later mention like
  // that defers to the commit trailer and never downgrades the known producer to legacy unknown.
  Journal.open(repo, runId).append("worktree-preserved", "T1", { ref: preservedRef });
  // Cherry-pick resume: the failed task is re-gated on the preserved snapshot with no worker.
  await approve([runId, "T1", "--recheck"], repo);
  expect(of(Journal.open(repo, runId).read(), "task-approved").at(-1)?.data.recheckedRef).toBe(preservedRef);
  expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).done).toEqual(["T1"]);
  rows = Journal.open(repo, runId).read();
  expect(of(rows, "worktree-recreation").at(-1)?.data.carried).toEqual([git(repo, "rev-parse", preservedRef)]);
  expect(git(repo, "show", `tickmarkr/${runId}:rescue.txt`)).toBe("rescue");
  const done = of(rows, "task-done").at(-1)!;
  // B is the last dispatch; the merged subject is A's alone.
  expect(channelKey(done.data.assignment as never)).toBe(seatB);
  expect(done.data.authors).toEqual([producerA]);
  const task = readOperatorState({ events: rows, graph: loadGraph(repo) }).tasks.find((t) => t.id === "T1")!;
  expect(task).toMatchObject({ channel: seatB, authors: [producerA] });

  // An unattributed caller (no known producing attempt) preserves as explicit unknown.
  const dirty = mkdtempSync(join(tmpdir(), "tickmarkr-unattributed-"));
  git(dirty, "init", "-q");
  git(dirty, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--no-gpg-sign", "-qm", "base");
  writeFileSync(join(dirty, "loose.txt"), "loose\n");
  const unknownRef = (await preserveWorktree(dirty))!;
  expect(git(dirty, "log", "-1", "--format=%B", unknownRef)).toContain("Tickmarkr-Producer: unknown");
  expect(git(dirty, "log", "-1", "--format=%B", unknownRef)).not.toContain("attempt");
}, 240_000);
