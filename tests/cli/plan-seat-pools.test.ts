// Rows 362 and 367 R5 (D-2187 condition 5): `tickmarkr plan` prints a seat pools block — each role's seats
// in the seat resolver's order, each skipped preference and each DEAD entry beneath its role — and every
// task's judge line names the resolver's judge for that task's routed author. Stub adapters, zero tokens.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { rolePools, writeDoctor } from "../../src/adapters/registry.js";
import { type AuthHealth, type BillingChannel, channelKey, type WorkerAdapter } from "../../src/adapters/types.js";
import { deadPreferenceLine } from "../../src/cli/commands/doctor.js";
import { plan, type PlanTaskRow } from "../../src/cli/commands/plan.js";
import { loadConfig } from "../../src/config/config.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { carriedAuthorVendors, deadPreferences, isIndependentJudge, resolveSeats } from "../../src/route/seat-resolver.js";
import { makeRepo } from "../helpers/tmprepo.js";

type Tier = BillingChannel["tier"];
const ch = (adapter: string, vendor: string, model: string, tier: Tier, channel: "sub" | "api" = "sub"): BillingChannel =>
  ({ adapter, vendor, model, channel, tier });
const FLEET: Record<string, BillingChannel[]> = {
  alpha: [ch("alpha", "va", "a-hi", "frontier"), ch("alpha", "va", "a-mid", "mid")],
  beta: [ch("beta", "vb", "b-hi", "frontier", "api"), ch("beta", "vb", "b-mid", "mid")],
  gamma: [ch("gamma", "vc", "c-hi", "frontier")],
};
const ADAPTERS: WorkerAdapter[] = Object.entries(FLEET).map(([id, channels]) => ({
  id,
  vendor: channels[0]!.vendor,
  probe: async () => { throw new Error("plan reads the cache"); },
  channels: () => channels,
  headlessCommand: () => { throw new Error("plan launches no seat"); },
  interactiveCommand: () => null,
}) as unknown as WorkerAdapter);

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PINS = { chore: { pin: { via: "beta", model: "b-hi" } }, implement: { pin: { via: "alpha", model: "a-mid" } } };

// T1 (chore) and T2 (implement) are pinned through routing.map; both carry a judge criterion.
function planRepo(overlay: { routing?: object } & Record<string, unknown>, map: object = PINS): { repo: string; health: Record<string, AuthHealth> } {
  const xdg = mkdtempSync(join(tmpdir(), "tkr-plan-pools-xdg-"));
  scratch.push(xdg);
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [
      { id: "T1", title: "t1", goal: "g", shape: "chore", complexity: 2, acceptance: ["judge me"] },
      { id: "T2", title: "t2", goal: "g", shape: "implement", complexity: 2, acceptance: ["judge me"] },
    ],
  }));
  const at = new Date(Date.now() - 5 * 60_000);
  const health: Record<string, AuthHealth> = Object.fromEntries(Object.entries(FLEET).map(([id, channels]) => [id, {
    installed: true, authed: true, models: channels.map((c) => c.model),
    modelAuth: Object.fromEntries(channels.map((c) => [c.model, { authed: true, probedAt: at.toISOString() }])),
  }]));
  writeDoctor(repo, health);
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), at, at);
  const { routing, ...rest } = overlay;
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `${JSON.stringify({ ...rest, routing: { map, ...routing } })}\n`);
  return { repo, health };
}

async function planned(repo: string) {
  const rows: PlanTaskRow[] = [];
  const out = await plan([], repo, ADAPTERS, undefined, { onTask: (row) => rows.push(row) });
  const block = out.slice(out.indexOf("\nseat pools:\n") + 1, out.indexOf("\n\n", out.indexOf("\nseat pools:\n")));
  return { out, rows, block: block.split("\n") };
}

describe("plan seat pools (rows 362 and 367 R5)", () => {
  test("plan prints each role seat pool with its skips and every task judge from the seat resolver", async () => {
    // Row 362's shape on both preference lists: the first entry is denied by routing.deny.models, so it is
    // skipped and DEAD; the configured judge beta:b-mid shares T1's routed author's vendor (vb).
    const { repo, health } = planRepo({
      judge: { adapter: "beta", model: "b-mid" },
      consult: { adapter: "gamma", model: "c-hi", prefer: ["alpha:a-hi", "beta:b-hi"] },
      review: { prefer: ["alpha:a-hi", "gamma"] },
      routing: { deny: { models: ["alpha:a-hi"] } },
    });
    const { out, rows, block } = await planned(repo);
    const dead = (role: string) => `    DEAD: ${role}.prefer entry alpha:a-hi is disallowed for the ${role} seat by routing.deny (alpha:a-hi) — it is never chosen; remove it or the deny entry`;
    expect(block).toEqual([
      "seat pools:",
      "  worker: alpha:a-mid, beta:b-hi, beta:b-mid, gamma:c-hi",
      // The configured judge, then the failover draw: other adapters first (tier, then cost), then its own.
      "  judge: beta:b-mid, gamma:c-hi, alpha:a-mid, beta:b-hi",
      "  review: gamma:c-hi",
      "    skipped alpha:a-hi (alpha:a-hi) — denied: routing.deny (alpha:a-hi)",
      dead("review"),
      "  consult: beta:b-hi, gamma:c-hi",
      "    skipped alpha:a-hi (alpha:a-hi) — denied: routing.deny (alpha:a-hi)",
      dead("consult"),
    ]);

    // Every line is a seat resolver call's output — no second ranking in plan.
    const cfg = loadConfig(repo);
    const pools = rolePools(cfg, ADAPTERS, health);
    const keys = (seats: readonly { adapter: string; model: string }[]) => seats.map(channelKey).join(", ");
    const view = { cfg, adapters: ADAPTERS, health };
    const review = resolveSeats({ role: "review", pool: pools.review, prefer: cfg.review.prefer ?? [], ...view });
    const consult = resolveSeats({ role: "consult", pool: pools.consult, pin: { adapter: "gamma", model: "c-hi" }, ...view });
    expect(block[1]).toBe(`  worker: ${keys(resolveSeats({ role: "worker", pool: pools.worker }).ranked)}`);
    expect(block[2]).toBe(`  judge: ${keys(resolveSeats({ role: "judge", cfg, pool: pools.judge, authorPool: pools.review, health, authors: [] }).ranked)}`);
    expect(block[3]).toBe(`  review: ${keys(review.ranked)}`);
    expect(review.skips).toEqual([{ entry: "alpha:a-hi", channel: "alpha:a-hi", reason: "denied", detail: "routing.deny (alpha:a-hi)" }]);
    expect(block[6]).toBe(`  consult: ${keys(consult.ranked)}`);
    expect(consult.skips).toEqual(review.skips);
    expect(deadPreferences(cfg, ADAPTERS, health).map((d) => `    ${deadPreferenceLine(d)}`)).toEqual([dead("review"), dead("consult")]);

    // Each task's judge: the run's primary judge for its routed author. T1's author beta:b-hi shares the
    // configured judge's vendor, so the independent automatic pick; T2's author alpha:a-mid does not.
    expect(rows.map((r) => [r.id, r.worker && `${r.worker.adapter}:${r.worker.model}`, r.judge]))
      .toEqual([["T1", "beta:b-hi", "gamma:c-hi"], ["T2", "alpha:a-mid", "beta:b-mid"]]);
    for (const row of rows) {
      const authors = [`${row.worker!.adapter}:${row.worker!.model}`];
      const { pick } = resolveSeats({ role: "judge", cfg, pool: pools.judge, authorPool: pools.review, health, authors });
      expect(row.judge).toBe(channelKey(pick!));
      expect(out).toContain(`    judge: ${row.judge}\n`);
    }

    // No independent judge left: the same-vendor fallback, annotated exactly where the run annotates it.
    const lone = planRepo(
      { judge: { adapter: "beta", model: "b-mid" }, routing: { deny: { adapters: ["alpha", "gamma"] } } },
      { chore: { pin: { via: "beta", model: "b-hi" } }, implement: { pin: { via: "beta", model: "b-mid" } } },
    );
    const fallback = await planned(lone.repo);
    const loneCfg = loadConfig(lone.repo);
    const lonePools = rolePools(loneCfg, ADAPTERS, lone.health);
    const t1 = fallback.rows.find((r) => r.id === "T1")!;
    const { pick } = resolveSeats({ role: "judge", cfg: loneCfg, pool: lonePools.judge, authorPool: lonePools.review, health: lone.health, authors: ["beta:b-hi"] });
    const seats = [...lonePools.judge, ...lonePools.review];
    const seat = seats.find((c) => channelKey(c) === channelKey(pick!))!;
    expect(isIndependentJudge(seat, carriedAuthorVendors(seats, ["beta:b-hi"]), ["beta:b-hi"])).toBe(false);
    expect(t1.judge).toBe(`${channelKey(pick!)} (not independent)`);
    expect(t1.judge).toBe("beta:b-mid (not independent)");
    expect(fallback.block[2]).toMatch(/^ {2}judge: beta:b-mid/);
  });
});
