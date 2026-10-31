import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { codex } from "../../src/adapters/codex.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { discoverChannels } from "../../src/adapters/registry.js";
import { type BillingChannel, channelKey, shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { pickReviewer } from "../../src/gates/review.js";
import { isIndependentJudge, judgmentSubjectKey, runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const seat = (adapter: string, vendor: string, model: string): BillingChannel =>
  ({ adapter, vendor, model, tier: "frontier", channel: "api" });
const author = seat("codex", "openai", "gpt-worker");
const unknown = seat("claude-code", "unknown", "claude-proxy");
const outside = seat("outside", "zhipu", "glm-reviewer");
const backup = seat("backup", "moonshot", "kimi-reviewer");

test("test: the reviewer picker never seats a vendor-unknown channel even when it is the only other channel, so a gateway alias of the author's own model reviewing that author fails", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers["claude-code"] = { vendor: "anthropic", channel: "api", models: { [unknown.model]: "frontier" } };
  cfg.tiers.codex = { vendor: "openai", channel: "api", models: { [author.model]: "frontier" } };
  const health = Object.fromEntries([claudeCode, codex].map((a) => {
    const models = Object.keys(cfg.tiers[a.id].models);
    return [a.id, { installed: true, authed: true, models, modelAuth: authedModels(models) }];
  }));
  const channels = discoverChannels(cfg, [codex, claudeCode], health, "review", "gateway.example");
  expect(channels.find((c) => c.adapter === "claude-code")?.vendor).toBe("unknown");
  expect(pickReviewer(author, channels)).toBeNull();
  expect(pickReviewer(author, channels, [], [channelKey(unknown)])).toBeNull();
  expect(pickReviewer(author, [...channels, outside], [], [channelKey(unknown)])).toEqual(outside);
  // An unknown vendor can still author work; only its reviewer must have a known vendor.
  expect(pickReviewer(unknown, [...channels, outside])).toEqual(author);
});

class Judge extends FakeAdapter {
  calls: string[] = [];
  constructor(path: string, public override id: string, private replies: ("pass" | "garbage")[]) { super(path); }
  override headlessCommand(file: string, model: string): string {
    this.calls.push(model);
    if (this.replies[this.calls.length - 1] === "garbage") return "printf garbage";
    const nonce = readFileSync(file, "utf8").match(/^VERDICT_NONCE: (.+)$/m)![1];
    return `printf '%s' ${shq(JSON.stringify({ nonce, pass: true, criteria: [
      { criterion: "c1", met: true, reason: "observed a.txt", evidence: { path: "a.txt", line: 1 } },
    ] }))}`;
  }
}

async function battery(configured: BillingChannel, pool: BillingChannel[], opts: {
  garbage?: string; adjudicate?: boolean;
} = {}) {
  const repo = makeRepo({ "a.txt": "before\n" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "after\n");
  git("commit", "-am", "work", "--no-gpg-sign");
  const script = join(makeTestTempDir("gateway-judge-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const adapters = [...new Set([configured, ...pool].map((c) => c.adapter))]
    .map((id) => new Judge(script, id, opts.garbage === id ? ["garbage", "pass"] : ["pass"]));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge = { adapter: configured.adapter, model: configured.model };
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", {
    files: ["a.txt"], gates: ["build", "test", "lint", "evidence", "scope", "acceptance"],
  })] }).tasks[0]!;
  const result = (await runGates(task, {
    worktree: repo, baseRef: base, author, result: { ok: true, summary: "done", deviations: [], raw: "" },
    commands: {}, baseline: await captureBaseline(repo, {}), cfg, adapters,
    channels: [author, configured, ...pool], judgeChannels: pool,
    ...(opts.adjudicate ? { priorJudgments: [{ commit: git("rev-parse", "HEAD"), judge: "prior:prior", criteria: [
      { id: "c1", key: judgmentSubjectKey(task, "done"), met: false, paths: ["a.txt"] },
    ] }] } : {}),
  })).results.find((r) => r.gate === "acceptance")!;
  return { result, calls: Object.fromEntries(adapters.map((a) => [a.id, a.calls])) };
}

test("test: the judge independence seam refuses a vendor-unknown seat and a seat of an author's vendor and accepts a declared different vendor, so a configured gateway judge treated as independent fails", async () => {
  const vendors = new Set([author.vendor]);
  const authors = [channelKey(author)];
  expect(isIndependentJudge(unknown, vendors, authors)).toBe(false);
  expect(isIndependentJudge({ ...outside, vendor: author.vendor }, vendors, authors)).toBe(false);
  expect(isIndependentJudge({ ...outside, vendor: "" }, vendors, authors)).toBe(false);
  expect(isIndependentJudge({ ...author, vendor: outside.vendor }, vendors, authors)).toBe(false);
  expect(isIndependentJudge(outside, vendors, authors)).toBe(true);

  const configured = await battery(unknown, [unknown, outside]);
  expect(configured.result).toMatchObject({ pass: true, meta: { judge: channelKey(outside) } });
  expect(configured.result.meta).not.toHaveProperty("judgeIndependent");
  expect(configured.calls[unknown.adapter]).toEqual([]);

  const sameVendor = seat("same", author.vendor, "other-openai");
  const pooled = await battery(sameVendor, [unknown, outside]);
  expect(pooled.result.meta?.judge).toBe(channelKey(outside));
  expect(pooled.calls[unknown.adapter]).toEqual([]);
  const alone = await battery(unknown, [unknown]);
  expect(alone.result).toMatchObject({ pass: false, meta: { infra: true, judgeIndependent: false } });
  expect(alone.calls[unknown.adapter]).toEqual([]);

  const retry = await battery(outside, [outside, unknown, backup], { garbage: outside.adapter });
  expect(retry.result).toMatchObject({ pass: true, meta: { judge: channelKey(backup) } });
  expect(retry.calls[unknown.adapter]).toEqual([]);
  const fallback = await battery(unknown, [unknown, outside], { garbage: outside.adapter });
  expect(fallback.result).toMatchObject({ pass: true, meta: { judge: channelKey(outside) } });
  expect(fallback.calls[outside.adapter]).toEqual([outside.model, outside.model]);
  expect(fallback.calls[unknown.adapter]).toEqual([]);

  const adjudication = await battery(outside, [outside, unknown, backup], { adjudicate: true });
  expect(adjudication.result).toMatchObject({ pass: true, meta: { adjudication: { adjudicator: channelKey(backup), agreed: true } } });
  expect(adjudication.calls[unknown.adapter]).toEqual([]);
});
