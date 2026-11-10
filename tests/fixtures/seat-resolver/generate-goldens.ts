// Queue row 367 Phase 1 (D-2187 condition 1): the seat-resolver parity instrument. It drives a CLOSED
// scenario set through the four production seat seams as they stand — `tickmarkr fleet --pick` (the
// fleet command function), the review gate's reviewer pick (pickReviewer), the escalation consult
// (consult, every seat answering unparseably so the whole seat walk is observed) and the acceptance
// judge (runGates, every judge answering unparseably so the primary AND its failover are observed) —
// and prints one canonical JSON document of what each seam chose.
//
// The committed output beside this file was produced by running this generator on private main
// a851f41b7 (2.23.0 + atlas), BEFORE any resolver change:
//   npx tsx tests/fixtures/seat-resolver/generate-goldens.ts > tests/fixtures/seat-resolver/goldens.base.json
// A resolver change is behaviour-preserving only when this same generator, unedited, reproduces that
// file byte-for-byte. Never regenerate the golden from a changed tree: a golden written after the
// change proves nothing. Zero tokens: every adapter here is a stub that echoes a non-verdict.
//
// Projections are deliberately narrow (the chosen seats, their order, the refusal token or the gate's
// refusal text) so additive receipt fields — named skips, cache age — never disturb parity.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolePools, writeDoctor } from "../../../src/adapters/registry.js";
import { type Assignment, type AuthHealth, type BillingChannel, channelKey, type WorkerAdapter } from "../../../src/adapters/types.js";
import { fleet } from "../../../src/cli/commands/fleet.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../../src/config/config.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { captureBaseline } from "../../../src/gates/baseline.js";
import { pickReviewer } from "../../../src/gates/review.js";
import { runGates } from "../../../src/gates/run-gates.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { consult, type Dossier } from "../../../src/run/consult.js";

type Tier = BillingChannel["tier"];
const ch = (adapter: string, vendor: string, model: string, tier: Tier, channel: "sub" | "api" = "sub"): BillingChannel =>
  ({ adapter, vendor, model, channel, tier });

// The closed fleet: three known vendors and one gateway channel with no declared vendor.
const FLEET: Record<string, BillingChannel[]> = {
  alpha: [ch("alpha", "va", "a-hi", "frontier"), ch("alpha", "va", "a-mid", "mid")],
  beta: [ch("beta", "vb", "b-hi", "frontier", "api"), ch("beta", "vb", "b-mid", "mid")],
  gamma: [ch("gamma", "vc", "c-hi", "frontier")],
  delta: [ch("delta", "unknown", "d-gw", "frontier")],
};

const calls: string[] = [];
function stubAdapters(): WorkerAdapter[] {
  return Object.entries(FLEET).map(([id, channels]) => ({
    id,
    vendor: channels[0]!.vendor,
    probe: async () => { throw new Error("goldens never probe"); },
    channels: () => channels,
    headlessCommand(_promptFile: string, model: string): string {
      calls.push(`${id}:${model}`);
      return "echo not-a-verdict";
    },
    interactiveCommand: () => null,
  }) as unknown as WorkerAdapter);
}

function healthyFleet(probedAt: string): Record<string, AuthHealth> {
  return Object.fromEntries(Object.entries(FLEET).map(([id, channels]) => [id, {
    installed: true, authed: true, models: channels.map((c) => c.model),
    modelAuth: Object.fromEntries(channels.map((c) => [c.model, { authed: true, probedAt }])),
  }]));
}

interface Scenario {
  name: string;
  cfg?: (cfg: TickmarkrConfig) => void;
  health?: (health: Record<string, AuthHealth>) => void;
  author?: string; // adapter:model of the worker that authored the diff (default beta:b-hi)
  carried?: string[]; // carried lifetime authors (default: the author alone)
  floor?: Tier;
  exclude?: string[];
  history?: string[];
  demoted?: string[];
  excludeVendors?: string[];
}

// CLOSED scenario list. Adding a scenario is a new golden generated at a base, never an edit after a change.
const SCENARIOS: Scenario[] = [
  { name: "s01-healthy-default" },
  { name: "s02-judge-pin-is-the-author", cfg: (c) => { c.judge = { adapter: "beta", model: "b-hi" }; } },
  { name: "s03-judge-pin-same-vendor-as-author", cfg: (c) => { c.judge = { adapter: "beta", model: "b-mid" }; } },
  { name: "s04-judge-pin-denied-by-model", cfg: (c) => { c.judge = { adapter: "alpha", model: "a-hi" }; c.routing.deny = { models: ["a-hi"] }; } },
  { name: "s05-judge-pin-unknown-vendor", cfg: (c) => { c.judge = { adapter: "delta", model: "d-gw" }; } },
  {
    name: "s06-no-independent-judge-left",
    cfg: (c) => { c.judge = { adapter: "beta", model: "b-mid" }; c.routing.deny = { adapters: ["alpha", "gamma", "delta"] }; },
  },
  { name: "s07-first-preference-adapter-unauthed", health: (h) => { h.alpha!.authed = false; } },
  { name: "s08-first-preference-model-unauthed", health: (h) => { h.alpha!.modelAuth!["a-hi"]!.authed = false; } },
  {
    name: "s09-first-preference-not-installed",
    cfg: (c) => { c.consult.prefer = ["gamma:c-hi", "alpha:a-hi"]; c.review.prefer = ["gamma:c-hi", "alpha"]; },
    health: (h) => { h.gamma!.installed = false; },
  },
  { name: "s10-no-preference-eligible-pin-fallback", cfg: (c) => { c.consult.prefer = ["alpha:missing-model"]; c.review.prefer = ["alpha:missing-model"]; } },
  { name: "s11-missing-prefer", cfg: (c) => { delete c.consult.prefer; delete c.review.prefer; } },
  { name: "s12-worker-only-deny-keeps-seats", cfg: (c) => { c.routing.deny = { workers: { adapters: ["alpha"] } }; } },
  { name: "s13-excluded-vendor", excludeVendors: ["va"] },
  { name: "s14-floor-history-demoted", floor: "frontier", history: ["gamma:c-hi"], demoted: ["alpha:a-hi"] },
  { name: "s15-carried-authors", author: "beta:b-hi", carried: ["beta:b-hi", "gamma:c-hi"], cfg: (c) => { c.judge = { adapter: "gamma", model: "c-hi" }; } },
  { name: "s16-every-consult-seat-denied", cfg: (c) => { c.consult.prefer = ["alpha:a-hi"]; c.routing.deny = { models: ["a-hi", "c-hi"] }; } },
  { name: "s17-adapter-form-review-prefer", cfg: (c) => { c.consult.prefer = ["beta:b-mid", "alpha:a-hi"]; c.review.prefer = ["alpha", "gamma"]; } },
  { name: "s18-exclude-list-and-mid-author", author: "alpha:a-mid", exclude: ["gamma:c-hi"] },
];

function baseCfg(): TickmarkrConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.visibility.llm = "headless";
  cfg.judge = { adapter: "gamma", model: "c-hi" };
  cfg.consult = { ...cfg.consult, adapter: "gamma", model: "c-hi", prefer: ["alpha:a-hi", "beta:b-hi"] };
  cfg.review = { ...cfg.review, prefer: ["gamma", "alpha:a-hi"] };
  return cfg;
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tkr-seat-goldens-${prefix}-`));
  scratch.push(dir);
  return dir;
};

// fleet --pick: worker and consult only. A judge or review pick without an author is ruled to refuse
// with context-required from 2.24.0 (Q-a), so those two cells are behaviour CHANGES, not parity.
async function pickCells(s: Scenario, cfg: TickmarkrConfig, health: Record<string, AuthHealth>, adapters: WorkerAdapter[]) {
  const repo = tmp("pick");
  const globalDir = tmp("global");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  // The overlay carries exactly the scenario's seat-relevant keys, as JSON (valid YAML flow).
  const overlay = { judge: cfg.judge, consult: cfg.consult, review: { prefer: cfg.review.prefer }, routing: { deny: cfg.routing.deny ?? null } };
  if (!cfg.consult.prefer) delete (overlay.consult as { prefer?: unknown }).prefer;
  if (!cfg.review.prefer) delete overlay.review.prefer;
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `${JSON.stringify(overlay)}\n`);
  writeDoctor(repo, health);
  const out: Record<string, unknown> = {};
  for (const role of ["worker", "consult"] as const) {
    const argv = ["--pick", role, "--global-dir", globalDir, ...(s.excludeVendors ?? []).flatMap((v) => ["--exclude-vendor", v])];
    const r = await fleet(argv, repo, adapters);
    if (typeof r === "string") {
      const { adapter, model, vendor, channel } = JSON.parse(r) as Record<string, string>;
      out[role] = { adapter, model, vendor, channel };
    } else {
      out[role] = { refused: r.out.replace(/^.*?\.prefer: /u, ""), code: r.code };
    }
  }
  return out;
}

function reviewCell(s: Scenario, cfg: TickmarkrConfig, pools: Record<string, BillingChannel[]>) {
  const authorKey = s.author ?? "beta:b-hi";
  const authorCh = Object.values(FLEET).flat().find((c) => channelKey(c) === authorKey)!;
  const author: Assignment = { adapter: authorCh.adapter, model: authorCh.model, channel: authorCh.channel, tier: authorCh.tier };
  let seat: { seat: number; count: number } | undefined;
  const reviewer = pickReviewer(
    author, pools.review!, s.exclude ?? [], cfg.review.prefer ?? [], s.floor, s.history ?? [],
    (n, count) => { seat = { seat: n, count }; }, new Set(s.demoted ?? []), new Set(s.excludeVendors ?? []),
    s.carried ?? [authorKey],
  );
  return { reviewer: reviewer ? channelKey(reviewer) : null, ...(seat ? seat : {}) };
}

const DOSSIER: Dossier = {
  taskId: "T1", trigger: "gate-fail", journalTail: "[]", transcript: "t",
  diff: "d", gates: [{ gate: "scope", pass: false, details: "out of scope" }],
};

async function consultCell(cfg: TickmarkrConfig, health: Record<string, AuthHealth>, pools: Record<string, BillingChannel[]>, adapters: WorkerAdapter[]) {
  calls.length = 0;
  const v = await consult(DOSSIER, cfg, adapters, new SubprocessDriver(), tmp("consult-cwd"), tmp("consult-run"), {
    channels: pools.consult, health,
  });
  return { seats: [...calls], action: v.action, notes: v.notes };
}

const JUDGE_GATES = ["build", "test", "lint", "evidence", "scope", "acceptance"];
async function judgeCell(s: Scenario, cfg: TickmarkrConfig, health: Record<string, AuthHealth>, pools: Record<string, BillingChannel[]>, adapters: WorkerAdapter[]) {
  const repo = tmp("judge");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "goldens@test.local"]);
  git(repo, ["config", "user.name", "goldens"]);
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base", "--no-gpg-sign"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "a.txt"), "y\n");
  git(repo, ["commit", "-q", "-am", "work", "--no-gpg-sign"]);
  const authorKey = s.author ?? "beta:b-hi";
  const authorCh = Object.values(FLEET).flat().find((c) => channelKey(c) === authorKey)!;
  const task = validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: JUDGE_GATES, files: [] }],
  }).tasks[0]!;
  calls.length = 0;
  const { results } = await runGates(task, {
    worktree: repo, baseRef: base,
    author: { adapter: authorCh.adapter, model: authorCh.model, channel: authorCh.channel, tier: authorCh.tier },
    result: { ok: true, summary: "", deviations: [], raw: "" },
    commands: {}, baseline: await captureBaseline(repo, {}),
    channels: pools.review!, judgeChannels: pools.judge!, health, adapters, cfg,
    ...(s.carried ? { carriedAuthors: s.carried } : {}),
  } as Parameters<typeof runGates>[1]);
  const acc = results.find((r) => r.gate === "acceptance");
  const meta = acc?.meta ?? {};
  return {
    seats: [...calls],
    pass: acc?.pass ?? null,
    ...(meta.judgeIndependent === false ? { judgeIndependent: false } : {}),
    ...(calls.length === 0 ? { details: acc?.details ?? null } : {}),
  };
}

export async function seatGoldens(): Promise<string> {
  const probedAt = new Date().toISOString();
  const adapters = stubAdapters();
  const doc: Record<string, unknown> = {};
  try {
    for (const s of SCENARIOS) {
      const cfg = baseCfg();
      s.cfg?.(cfg);
      const health = healthyFleet(probedAt);
      s.health?.(health);
      const pools = rolePools(cfg, adapters, health);
      doc[s.name] = {
        pick: await pickCells(s, cfg, health, adapters),
        review: reviewCell(s, cfg, pools),
        consult: await consultCell(cfg, health, pools, adapters),
        judge: await judgeCell(s, cfg, health, pools, adapters),
      };
    }
  } finally {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(await seatGoldens());
}
