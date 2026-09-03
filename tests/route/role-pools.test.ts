// v1.87 T2: policy-truth for every seat that reads the code — not just workers.
// `discoverChannels` gains an OPTIONAL role (default "worker"), `rolePools` builds one pool per seat
// role, and the judge / judge-failover / consult seats are checked against the operator's deny before
// a dispatch is spent on them. Every pre-existing two/three-argument call keeps its present behaviour.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { allAdapters, discoverChannels, rolePools } from "../../src/adapters/registry.js";
import { type Assignment, type AuthHealth, type BillingChannel, channelKey, shq, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { pickReviewer } from "../../src/gates/review.js";
import { runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { consult, type Dossier } from "../../src/run/consult.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

const SRC = (rel: string) => readFileSync(join(import.meta.dirname, "../../src", rel), "utf8");

function repoWithOverlay(yaml: string) {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return loadConfig(repo, { globalDir });
}

const adapters = allAdapters().filter((a) => a.id !== "fake");
const health = (): Record<string, AuthHealth> =>
  Object.fromEntries(adapters.map((a) => [a.id, { installed: true, authed: true, modelAuth: authedModels(a.channels(DEFAULT_CONFIG).map((c) => c.model)) }]));

// ── judge harness (shape borrowed from tests/gates/judge-retry.test.ts) ───────────────────────────
class CountingFake extends FakeAdapter {
  calls: string[] = [];
  headlessCommand(promptFile: string, model: string): string {
    this.calls.push(model);
    return super.headlessCommand(promptFile, model);
  }
}

function countingFake(verdicts: unknown[]): CountingFake {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-role-judge-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, judge: verdicts }));
  return new CountingFake(p);
}

const PASS_VERDICT = { pass: true, criteria: [{ criterion: "a", met: true, reason: "r", evidence: "+y" }] };
const JUDGE_GATES = ["build", "test", "lint", "evidence", "scope", "acceptance"];
const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const FAKE_TWO_CHANNELS: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];

const mkTask = () =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: JUDGE_GATES, files: [] }],
  }).tasks[0];

function repoWithCommit() {
  const repo = makeRepo({ "a.txt": "x\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

async function judgeCtx(repo: string, base: string, fake: CountingFake, judgeModel: string, deny: string[]) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  cfg.judge.model = judgeModel;
  cfg.routing.deny = { models: deny };
  return {
    worktree: repo, baseRef: base, author,
    result: { ok: true, summary: "", deviations: [] as string[], raw: "" },
    commands: {} as Record<string, string>,
    baseline: await captureBaseline(repo, {}),
    channels: FAKE_TWO_CHANNELS, judgeChannels: FAKE_TWO_CHANNELS,
    adapters: [fake] as WorkerAdapter[], cfg,
  };
}

// ── consult harness (shape borrowed from tests/run/consult.test.ts) ───────────────────────────────
const dossier: Dossier = {
  taskId: "T1", trigger: "gate-fail", journalTail: "[]", transcript: "t",
  diff: "d", gates: [{ gate: "scope", pass: false, details: "out of scope" }],
};

function seatAdapter(id: string, verdict: unknown): { adapter: WorkerAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter = {
    id,
    headlessCommand(promptFile: string, model: string): string {
      calls.push(model);
      const js = `const fs=require("fs");const n=/VERDICT_NONCE: ([0-9a-f]+)/.exec(fs.readFileSync(${JSON.stringify(promptFile)},"utf8"))[1];console.log(JSON.stringify({nonce:n,...${JSON.stringify(verdict)}}))`;
      return `node -e ${shq(js)}`;
    },
  } as unknown as WorkerAdapter;
  return { adapter, calls };
}

const consultCfg = (deny: string[]): TickmarkrConfig => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.consult = { adapter: "omega", model: "om-1", stallMinutes: 15, prefer: ["alpha:a-1", "beta:b-1"] };
  cfg.routing.deny = { models: deny };
  return cfg;
};
const runDir = () => mkdtempSync(join(tmpdir(), "tickmarkr-role-consult-"));

describe("v1.87 T2 role-scoped channel pools", () => {
  test("test: a channel denied only under deny.workers fills the review seat while the worker pool excludes it, proven through the daemon's role-scoped pools rather than the bare predicate", () => {
    const cfg = repoWithOverlay("routing:\n  deny:\n    workers:\n      models: [codex:gpt-5.5]\n");
    const pools = rolePools(cfg, adapters, health());
    const target = { adapter: "codex", model: "gpt-5.5" };

    // the pools disagree, which is the whole point: dispatch is benched, verification is not
    expect(pools.worker).not.toContainEqual(expect.objectContaining(target));
    expect(pools.review).toContainEqual(expect.objectContaining(target));

    // and the denied channel really does FILL the review seat when picked out of the review pool
    const reviewAuthor: Assignment = { adapter: "claude-code", model: "fable", channel: "sub", tier: "frontier" };
    const seat = pickReviewer(reviewAuthor, pools.review, [], ["codex:gpt-5.5"]);
    expect(channelKey(seat!)).toBe("codex:gpt-5.5");
    // the same pick over the WORKER pool can never land there — the channel isn't in it
    const fromWorkerPool = pickReviewer(reviewAuthor, pools.worker, [], ["codex:gpt-5.5"]);
    expect(fromWorkerPool && channelKey(fromWorkerPool)).not.toBe("codex:gpt-5.5");

    // proven through the DAEMON's pools: it builds them once and hands each seat its own
    const daemon = SRC("run/daemon.ts");
    expect(daemon).toContain("rolePools(cfg, adapters, health)");
    expect(daemon).toContain("const channels = pools.worker");
    expect(daemon).toContain("channels: pools.review");
    expect(daemon).toContain("judgeChannels: pools.judge");
    expect(daemon).toContain("channels: pools.consult");
  });

  test("test: a routing.deny entry naming the judge model refuses the judge and its failover before dispatch, and the recorded gate result names the deny entry", async () => {
    // (a) the configured judge is denied — a PASS verdict sits queued and is never asked for
    const { repo, base } = repoWithCommit();
    const denied = countingFake([PASS_VERDICT]);
    const { results } = await runGates(mkTask(), await judgeCtx(repo, base, denied, "fake-1", ["fake-1"]));
    const acc = results.find((r) => r.gate === "acceptance")!;
    expect(acc.pass).toBe(false);
    expect(acc.details).toContain("fake:fake-1");
    expect(acc.details).toMatch(/routing\.deny/);
    expect(acc.details).toContain("fake-1"); // the deny entry itself
    expect(denied.calls).toEqual([]); // refused BEFORE dispatch

    // (b) the failover seat obeys the same rule: fake:fake-1 is denied, so an unparseable verdict
    // from the allowed judge can never fail over onto it.
    const { repo: r2, base: b2 } = repoWithCommit();
    const flaky = countingFake(["not a verdict at all", PASS_VERDICT]);
    const { results: r } = await runGates(mkTask(), await judgeCtx(r2, b2, flaky, "fake-2", ["fake-1"]));
    const acc2 = r.find((x) => x.gate === "acceptance")!;
    expect((acc2.meta!.judgeRetry as { retried: string }).retried).toBe("fake:fake-2");
    expect(flaky.calls).toEqual(["fake-2", "fake-2"]);
    expect(flaky.calls).not.toContain("fake-1");
  });

  test("test: a model-scoped deny skips a consult.prefer seat, and the final pinned consult seat is checked by the same rule", async () => {
    // bare model id — not adapter, not adapter:model — still bans the alpha prefer seat
    const alpha = seatAdapter("alpha", { action: "reroute", notes: "denied seat must not answer" });
    const beta = seatAdapter("beta", { action: "retry", notes: "seat beta" });
    const omega = seatAdapter("omega", { action: "human", notes: "pin must not answer" });
    const v = await consult(
      dossier, consultCfg(["a-1"]), [alpha.adapter, beta.adapter, omega.adapter],
      new SubprocessDriver(), "/tmp", runDir(),
      { channels: [
        { adapter: "alpha", vendor: "alpha-vendor", model: "a-1", channel: "sub", tier: "frontier" },
        { adapter: "beta", vendor: "beta-vendor", model: "b-1", channel: "sub", tier: "frontier" },
      ] },
    );
    expect(v).toEqual({
      action: "retry", notes: "seat beta",
      adapter: "beta", model: "b-1", vendor: "beta-vendor",
    });
    expect(alpha.calls).toEqual([]);
    expect(beta.calls).toEqual(["b-1"]);

    // the FINAL pinned seat is checked by the same rule — a bare model deny on om-1 refuses it too
    const alpha2 = seatAdapter("alpha", { action: "reroute", notes: "not live" });
    const omega2 = seatAdapter("omega", { action: "reroute", notes: "pinned seat must not answer" });
    const pinned = await consult(
      dossier, consultCfg(["om-1"]), [alpha2.adapter, omega2.adapter],
      new SubprocessDriver(), "/tmp", runDir(),
      { channels: [] },
    );
    expect(omega2.calls).toEqual([]);
    expect(pinned.action).toBe("human");
    expect(pinned.notes).toMatch(/routing\.deny/);
    expect(pinned.notes).toContain("om-1");
  });

  test("the diff adds an optional role argument defaulting to worker and a role-scoped pool builder, so the two-argument form keeps its present behaviour, cited from the changed signature and pool-builder hunks", () => {
    const registry = SRC("adapters/registry.ts");
    expect(registry).toContain('role: PreferenceRole = "worker"'); // changed signature hunk
    expect(registry).toContain("export function rolePools("); // pool-builder hunk
    expect(registry).toContain("discoverChannels(cfg, adapters, health, role)");

    // the omitted argument IS the worker role, with or without a deny block in play
    for (const cfg of [
      repoWithOverlay(""),
      repoWithOverlay("routing:\n  deny:\n    workers:\n      models: [codex:gpt-5.5]\n"),
      repoWithOverlay("routing:\n  deny:\n    models: [codex:gpt-5.5]\n"),
    ]) {
      const h = health();
      expect(discoverChannels(cfg, adapters, h)).toEqual(discoverChannels(cfg, adapters, h, "worker"));
      expect(discoverChannels(cfg, adapters, h)).toEqual(rolePools(cfg, adapters, h).worker);
    }
  });
});
