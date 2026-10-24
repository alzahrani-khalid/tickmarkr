import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { channelKey, shq, type BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { SeatLaunchError } from "../../src/gates/llm.js";
import { judgmentSubjectKey, runGates, type GateContext } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const seat = (adapter: string, vendor: string, tier: BillingChannel["tier"] = "frontier", model = adapter): BillingChannel =>
  ({ adapter, model, vendor, tier, channel: "api" });
const author = seat("author", "author-vendor");
const primary = seat("primary", "author-vendor");
const outside = seat("outside", "other-vendor", "mid");
const other = seat("other", "third-vendor");
type Reply = boolean | "garbage" | "throw";

class Judge extends FakeAdapter {
  calls: string[] = [];
  constructor(path: string, public override id: string, private replies: Reply[]) { super(path); }
  override headlessCommand(file: string, model: string): string {
    this.calls.push(model);
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!;
    if (reply === "throw") throw new SeatLaunchError(channelKey({ adapter: this.id, model }), new Error("seat failed to launch"));
    if (reply === "garbage") return "printf garbage";
    const nonce = readFileSync(file, "utf8").match(/^VERDICT_NONCE: (.+)$/m)![1];
    return `printf '%s' ${shq(JSON.stringify({ nonce, pass: reply, criteria: [
      { criterion: "c1", met: reply, reason: "observed a.txt", evidence: { path: "a.txt", line: 1 } },
    ] }))}`;
  }
}

async function battery(pool: BillingChannel[], opts: {
  configured?: BillingChannel; authors?: string[]; replies?: Record<string, Reply[]>;
  adjudicate?: boolean; reviewChannels?: BillingChannel[]; deny?: string[];
} = {}) {
  const repo = makeRepo({ "a.txt": "before\n" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "after\n");
  git("commit", "-am", "work", "--no-gpg-sign");
  const script = join(makeTestTempDir("independent-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const configured = opts.configured ?? primary;
  const adapters = [...new Set([...pool, configured].map((s) => s.adapter))]
    .map((id) => new Judge(script, id, opts.replies?.[id] ?? [true]));
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", {
    files: ["a.txt"], gates: ["build", "test", "lint", "evidence", "scope", "acceptance"],
  })] }).tasks[0]!;
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge = { adapter: configured.adapter, model: configured.model };
  if (opts.deny) cfg.routing.deny = { adapters: opts.deny };
  const ctx: GateContext = {
    worktree: repo, baseRef: base, author, result: { ok: true, summary: "done", deviations: [], raw: "" },
    commands: {}, baseline: await captureBaseline(repo, {}), cfg, adapters,
    channels: opts.reviewChannels ?? [author, ...pool], judgeChannels: pool, carriedAuthors: opts.authors,
    ...(opts.adjudicate ? { priorJudgments: [{ commit: git("rev-parse", "HEAD"), judge: "prior:prior", criteria: [
      { id: "c1", key: judgmentSubjectKey(task, "done"), met: false, paths: ["a.txt"] },
    ] }] } : {}),
  };
  const result = (await runGates(task, ctx)).results.find((r) => r.gate === "acceptance")!;
  return { result, calls: Object.fromEntries(adapters.map((a) => [a.id, a.calls])) };
}

test("the gate battery whose configured judge shares the author's vendor while the judge pool holds a seat of another vendor dispatches its primary judge on that seat, while a configured judge of another vendor stays the primary, so a pick that ignores the authors or always re-picks from the pool fails", async () => {
  const replaced = await battery([primary, outside]);
  expect(replaced.result.pass).toBe(true);
  expect(replaced.result.meta?.judge).toBe(channelKey(outside));
  expect(replaced.calls.primary).toEqual([]);
  const retained = await battery([other, outside], { configured: outside });
  expect(retained.result.meta?.judge).toBe(channelKey(outside));
  expect(retained.calls.other).toEqual([]);
  const crossAdapter = await battery([primary, seat("primary", "other-vendor", "frontier", "second"), outside]);
  expect(crossAdapter.result.meta?.judge).toBe(channelKey(outside));
  const denied = await battery([primary, outside], { deny: ["outside"] });
  expect(denied.result.meta?.judge).toBe(channelKey(primary));
  const policy = await battery([primary, outside], { deny: ["primary"] });
  expect(policy.result.meta?.judgeDisallowed).toBeDefined();
  expect(Object.values(policy.calls).flat()).toEqual([]);
});

test("a judge retry whose pool ranks a channel of the author's vendor first retries on the best seat of another vendor, and an adjudication seats a judge outside both the authors' vendors and the primary when one exists, so a retry or adjudicator that seats an author's vendor fails", async () => {
  const retry = await battery([primary, other, outside], { configured: other, replies: { other: ["garbage"] } });
  expect(retry.result.meta?.judgeRetry).toEqual({ flaked: channelKey(other), retried: channelKey(outside) });
  expect(retry.result.meta?.judgeIndependent).toBeUndefined();
  const adjudicated = await battery([primary, other, outside], { configured: other, adjudicate: true });
  expect(adjudicated.result.pass).toBe(true);
  expect(adjudicated.result.meta?.adjudication).toMatchObject({ primary: channelKey(other), adjudicator: channelKey(outside), agreed: true });
  expect(adjudicated.calls.primary).toEqual([]);
  expect(adjudicated.result.meta?.judgeIndependent).toBeUndefined();
});

test("when only seats of the authors' vendors exist the configured judge, its retry or its adjudicator still runs and the acceptance row records its judge as not independent, while a battery judged by an independent seat records nothing, so a shortage that parks or stays unrecorded fails", async () => {
  const second = seat("second", "author-vendor");
  const alone = await battery([primary]);
  expect(alone.result.pass).toBe(true);
  expect(alone.result.meta).toMatchObject({ judge: channelKey(primary), judgeIndependent: false });
  const retry = await battery([primary, second], { replies: { primary: ["garbage"] } });
  expect(retry.result.pass).toBe(true);
  expect(retry.result.meta).toMatchObject({ judge: channelKey(second), judgeIndependent: false });
  const adjudicated = await battery([primary, second], { adjudicate: true });
  expect(adjudicated.result.pass).toBe(true);
  expect(adjudicated.result.meta).toMatchObject({ judgeIndependent: false, adjudication: { adjudicator: channelKey(second) } });
  const fallback = await battery([other, primary], { configured: other, replies: { other: ["garbage"] } });
  expect(fallback.result.meta).toMatchObject({ judge: channelKey(primary), judgeIndependent: false });
  const fallbackAdjudicator = await battery([other, primary], { configured: other, adjudicate: true });
  expect(fallbackAdjudicator.result.meta).toMatchObject({ judgeIndependent: false, adjudication: { adjudicator: channelKey(primary) } });
  const independent = await battery([primary, outside]);
  expect(independent.result.meta).not.toHaveProperty("judgeIndependent");
  const unresolved = await battery([], { configured: outside });
  expect(unresolved.result.pass).toBe(true);
  expect(unresolved.result.meta?.judgeIndependent).toBe(false);
  const doubleGarbage = await battery([primary, second], { replies: { primary: ["garbage"], second: ["garbage"] } });
  expect(doubleGarbage.result).toMatchObject({ pass: false, meta: { infra: true, retryable: false, unparseable: true } });
  const noDistinct = await battery([primary], { adjudicate: true });
  expect(noDistinct.result).toMatchObject({ pass: false, meta: { infra: true, retryable: false } });
  expect(noDistinct.result.details).toContain("no distinct eligible judge");
  const launch = await battery([other], { configured: other, replies: { other: ["throw"] } });
  expect(launch.result).toMatchObject({ pass: false, meta: { infra: true, retryable: false, cause: "seat-launch-failed" } });
});

test("the authors excluded are every lifetime author of the task, so a configured judge sharing the vendor of an earlier attempt's author is replaced although the current author's vendor differs, so a pick reading only the current author fails", async () => {
  const earlier = seat("earlier", "old-vendor");
  const configured = seat("primary", "old-vendor");
  const result = await battery([configured, outside], {
    configured, authors: [channelKey(earlier), channelKey(author)], reviewChannels: [author, earlier],
  });
  expect(result.result.meta?.judge).toBe(channelKey(outside));
  expect(result.calls.primary).toEqual([]);
});
