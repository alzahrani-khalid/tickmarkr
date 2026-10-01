// C (v2.6.5 T5): the daemon's review-recovery pick carries every preserved author of the subject, exactly
// as reviewGate's own pick does — never only the current assignment. Zero tokens: fake adapters and a
// scripted gate round at the daemon's recovery seam.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import type { BillingChannel } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { captureBaseline } from "../../../src/gates/baseline.js";
import * as gateRunner from "../../../src/gates/run-gates.js";
import type { GateResult } from "../../../src/graph/schema.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

class Seat extends FakeAdapter {
  constructor(path: string, public override id: string, vendor: string) {
    super(path);
    this.vendor = vendor;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("runDaemon recovery with two carried authors from two vendors selects an eligible third-vendor reviewer while candidates matching either carried author identity or vendor are excluded despite a different current assignment", async () => {
  // An openai attempt's preserved commit, upheld and repaired by an anthropic seat: the subject carries both.
  const seats = ["other-openai", "other-anthropic", "third-b", "third-review"];
  const made = setupRepo([T("T1", { files: ["work.txt", "fix.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })], {
    tasks: { T1: [{ shell: `echo fix > fix.txt && ${COMMIT} fix`, result: { ok: true, summary: "repaired" } }] },
  }, `review: { required: true, prefer: [fake, other-openai, other-anthropic, third-review] }\nrouting: { deny: { workers: { adapters: [${seats.join(", ")}] } } }\n`);
  made.fake.channels = () => [
    { adapter: "fake", model: "fake-1", vendor: "openai", channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "anthropic", channel: "api", tier: "frontier" },
  ];
  const runId = "run-recovery-authors";
  const baseRef = git(made.repo, "rev-parse", "HEAD");
  const branch = `tickmarkr/${runId}`;
  const wt = await new SubprocessDriver().worktree(made.repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "work.txt"), "original work\n");
  git(wt, "add", "work.txt");
  git(wt, "commit", "--no-gpg-sign", "-m", "original");
  const journal = Journal.create(made.repo, runId);
  journal.append("run-start", undefined, { baseRef, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(made.repo)) });
  journal.append("task-dispatch", "T1", { attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
  journal.append("worker-result", "T1", { ok: true, summary: "original work", deviations: [] });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "request changes: work.txt needs correction" });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "review needs correction" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(await captureBaseline(made.repo, {})));
  await approve([runId, "T1", "--uphold", "--review-rounds", "1"], made.repo);

  // The round's first review returns no verdict from a third-vendor seat; the DAEMON's recovery picks next.
  const seen: { author: string; carried: readonly string[] }[] = [];
  vi.spyOn(gateRunner, "runGates").mockImplementation(async (task, ctx) => {
    seen.push({ author: `${ctx.author.adapter}:${ctx.author.model}`, carried: [...(ctx.carriedAuthors ?? [])] });
    const results: GateResult[] = task.gates.filter((g) => g !== "review").map((gate) => ({ gate, pass: true, details: "ok" }));
    for (const g of results) {
      await ctx.onGate?.({ phase: "start", gate: g.gate as never, index: 0, total: task.gates.length });
      await ctx.onGate?.({ phase: "end", gate: g.gate as never, result: g });
    }
    const first = seen.length === 1;
    const reviewer = first ? "third-b:third-b"
      : String(Journal.open(made.repo, runId).read().filter((e) => e.event === "review-infra-retry").at(-1)?.data.reviewer);
    const review: GateResult = first
      ? { gate: "review", pass: false, details: "no verdict", meta: { reviewer, cause: "seat-launch-failed", noVerdict: true, infra: true, classification: "infra" } }
      : { gate: "review", pass: true, details: "approved", meta: { reviewer } };
    await ctx.onGate?.({ phase: "start", gate: "review", index: 0, total: task.gates.length });
    if (first) await ctx.onGate?.({ phase: "note", gate: "review", name: "review-no-verdict", payload: { ...review.meta }, result: review });
    await ctx.onGate?.({ phase: "end", gate: "review", result: review });
    return { results: [...results, review], commits: [] };
  });
  const adapters = [made.fake, new Seat(made.scriptPath, "other-openai", "openai"), new Seat(made.scriptPath, "other-anthropic", "anthropic"),
    new Seat(made.scriptPath, "third-b", "third-vendor-b"), new Seat(made.scriptPath, "third-review", "third-vendor")];
  const s = await runDaemon(made.repo, { adapters, runId, resume: true });
  expect(s.done).toEqual(["T1"]);

  const rows = journal.read();
  // the current assignment is the anthropic repair seat; the subject carries BOTH vendors' authors
  expect(rows.filter((r) => r.event === "task-dispatch").at(-1)?.data.assignment).toMatchObject({ adapter: "fake", model: "fake-2" });
  expect(seen[0]!.author).toBe("fake:fake-2");
  expect([...seen[0]!.carried].sort()).toEqual(["fake:fake-1", "fake:fake-2"]);
  // preferred seats sharing a carried author's identity (fake:fake-1) or vendor (openai, anthropic) are
  // excluded although neither is the current assignment's; the eligible third vendor is seated
  const retries = rows.filter((r) => r.event === "review-infra-retry" && r.taskId === "T1");
  expect(retries.map((r) => r.data.reviewer)).toEqual(["third-review:third-review"]);
  expect(seen).toHaveLength(2);
  expect(rows.filter((r) => r.event === "gate-result" && r.data.gate === "review").at(-1)?.data).toMatchObject({ pass: true, reviewer: "third-review:third-review" });
}, 120_000);
