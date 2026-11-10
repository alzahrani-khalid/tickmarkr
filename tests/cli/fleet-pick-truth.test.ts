// Rows 362 and 367 R2/R5, ruling Q-a (D-2187 conditions 4 and 5): `tickmarkr fleet --pick` tells the
// truth. Every cell runs the production fleet command on stub adapters (zero tokens) against a doctor
// cache written at a fixed age, and is cross-checked against the seat resolver and the run's own seams.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { discoverChannels, rolePools, writeDoctor } from "../../src/adapters/registry.js";
import { type AuthHealth, type BillingChannel, channelKey, type WorkerAdapter } from "../../src/adapters/types.js";
import { fleet } from "../../src/cli/commands/fleet.js";
import { commandHelp } from "../../src/cli/help.js";
import { dispatch } from "../../src/cli/index.js";
import { loadConfig } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { carriedAuthorVendors, gateReviewerFloor, pickReviewer } from "../../src/gates/review.js";
import { runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { pickRole } from "../../src/route/role-pick.js";
import { isIndependentJudge, resolveSeats } from "../../src/route/seat-resolver.js";

type Tier = BillingChannel["tier"];
const ch = (adapter: string, vendor: string, model: string, tier: Tier, channel: "sub" | "api" = "sub"): BillingChannel =>
  ({ adapter, vendor, model, channel, tier });
const FLEET: Record<string, BillingChannel[]> = {
  alpha: [ch("alpha", "va", "a-hi", "frontier"), ch("alpha", "va", "a-mid", "mid")],
  beta: [ch("beta", "vb", "b-hi", "frontier", "api"), ch("beta", "vb", "b-mid", "mid")],
  gamma: [ch("gamma", "vc", "c-hi", "frontier")],
};
const calls: string[] = [];
const ADAPTERS: WorkerAdapter[] = Object.entries(FLEET).map(([id, channels]) => ({
  id,
  vendor: channels[0]!.vendor,
  probe: async () => { throw new Error("pick never probes"); },
  channels: () => channels,
  headlessCommand(_promptFile: string, model: string): string {
    calls.push(`${id}:${model}`);
    return "echo not-a-verdict";
  },
  interactiveCommand: () => null,
}) as unknown as WorkerAdapter);

const MINUTE = 60_000;
const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tkr-pick-truth-${prefix}-`));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A doctor cache whose every verdict and whose file are `ageMs` old. */
function writeCache(repo: string, ageMs: number, edit?: (h: Record<string, AuthHealth>) => void): Record<string, AuthHealth> {
  const at = new Date(Date.now() - ageMs);
  const health: Record<string, AuthHealth> = Object.fromEntries(Object.entries(FLEET).map(([id, channels]) => [id, {
    installed: true, authed: true, models: channels.map((c) => c.model),
    modelAuth: Object.fromEntries(channels.map((c) => [c.model, { authed: true, probedAt: at.toISOString() }])),
  }]));
  edit?.(health);
  writeDoctor(repo, health);
  utimesSync(join(repo, ".tickmarkr", "doctor.json"), at, at);
  return health;
}

/** Row 362's shape: the user overlay holds the preferences, the repository's tracked overlay the deny. */
function fixture(user: object, repoOverlay: object = {}) {
  const repo = tmp("repo");
  const globalDir = tmp("global");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(globalDir, "config.yaml"), `${JSON.stringify({ visibility: { llm: "headless" }, ...user })}\n`);
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `${JSON.stringify(repoOverlay)}\n`);
  return { repo, globalDir, cfg: () => loadConfig(repo, { globalDir }) };
}

/** Run one pick and capture both streams: the returned text is what the CLI prints on stdout. */
async function pick(f: { repo: string; globalDir: string }, argv: string[]) {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write");
  let result: Awaited<ReturnType<typeof fleet>>;
  let errChunks: unknown[] = [];
  let stdoutWrites = 0;
  try {
    result = await fleet([...argv, "--global-dir", f.globalDir], f.repo, ADAPTERS);
  } finally {
    // mockRestore clears the recorded calls: read them first.
    errChunks = stderr.mock.calls.map(([chunk]) => chunk);
    stdoutWrites = stdout.mock.calls.length;
    stderr.mockRestore();
    stdout.mockRestore();
  }
  expect(stdoutWrites).toBe(0);
  const err = errChunks.map(String).join("").split("\n").filter(Boolean);
  if (typeof result !== "string") return { refused: result, err };
  // stdout is exactly one JSON object: one line, one object.
  expect(result.split("\n")).toHaveLength(1);
  const receipt = JSON.parse(result) as Record<string, unknown>;
  expect(receipt).toBeTypeOf("object");
  return { receipt, err };
}

const CONSULT = { judge: { adapter: "gamma", model: "c-hi" }, consult: { adapter: "gamma", model: "c-hi", prefer: ["alpha:a-hi", "beta:b-hi"] } };
const DENY_FIRST = { routing: { deny: { models: ["alpha:a-hi"] } } };
const SKIP_LINE = "tickmarkr fleet --pick consult: skipped alpha:a-hi (alpha:a-hi) — denied: routing.deny (alpha:a-hi)";
const STALE_LINE = "tickmarkr fleet --pick consult: doctor cache is 180m old (stale) — picked from cached verdicts; run tickmarkr doctor to refresh";
const CONTEXT_LINE = (role: string) =>
  `tickmarkr fleet --pick ${role}: context-required — pass --author <adapter:model>, the worker whose diff this seat would judge`;

describe("fleet pick truth (rows 362 and 367 R2/R5, Q-a)", () => {
  test("fleet pick names each skipped preference with its reason on stderr and in the receipt and picks from a stale cache reporting its age in both", async () => {
    const f = fixture(CONSULT, DENY_FIRST);

    // Fresh cache: the codex-shaped second entry is picked and the denied first entry is named, both places.
    const health = writeCache(f.repo, 5 * MINUTE);
    const fresh = await pick(f, ["--pick", "consult"]);
    const resolved = resolveSeats({
      role: "consult", cfg: f.cfg(), pool: discoverChannels(f.cfg(), ADAPTERS, health, "consult"), adapters: ADAPTERS, health,
    });
    const shared = pickRole("consult", f.cfg(), ADAPTERS, health);
    expect(fresh.receipt).toEqual({
      role: "consult", adapter: "beta", model: "b-hi", vendor: "vb", channel: "api",
      skips: [{ entry: "alpha:a-hi", channel: "alpha:a-hi", reason: "denied", detail: "routing.deny (alpha:a-hi)" }],
      cache: { ageMs: expect.any(Number), stale: false },
    });
    // Every receipt field is the resolver's: the pick (through pickRole) and the skip rows.
    expect(shared.ok && channelKey(shared.channel)).toBe("beta:b-hi");
    expect(resolved.pick && channelKey(resolved.pick)).toBe("beta:b-hi");
    expect(fresh.receipt!.skips).toEqual(resolved.skips);
    expect((fresh.receipt!.cache as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(5 * MINUTE);
    expect((fresh.receipt!.cache as { ageMs: number }).ageMs).toBeLessThan(6 * MINUTE);
    expect(fresh.err).toEqual([SKIP_LINE]);

    // The same cache three hours old: read at any age, as run start reads it — same pick, stale reported twice.
    writeCache(f.repo, 180 * MINUTE);
    const stale = await pick(f, ["--pick", "consult"]);
    expect(stale.receipt).toEqual({ ...fresh.receipt, cache: { ageMs: expect.any(Number), stale: true } });
    expect((stale.receipt!.cache as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(180 * MINUTE);
    expect((stale.receipt!.cache as { ageMs: number }).ageMs).toBeLessThan(181 * MINUTE);
    expect(stale.err).toEqual([SKIP_LINE, STALE_LINE]);

    // Control: the deny removed — the first entry is picked, nothing is skipped, nothing on stderr.
    const open = fixture(CONSULT);
    writeCache(open.repo, 5 * MINUTE);
    const control = await pick(open, ["--pick", "consult"]);
    expect(control.receipt).toMatchObject({ adapter: "alpha", model: "a-hi", skips: [], cache: { stale: false } });
    expect(control.err).toEqual([]);

    // Control: every prefer entry ineligible — refused as at the base, every skip still named on stderr.
    const shut = fixture(CONSULT, { routing: { deny: { models: ["alpha:a-hi", "beta:b-hi"] } } });
    writeCache(shut.repo, 180 * MINUTE);
    const none = await pick(shut, ["--pick", "consult"]);
    expect(none.refused).toEqual({ code: 1, out: "tickmarkr fleet --pick consult: consult.prefer: no-eligible-preferred-channel" });
    expect(none.err).toEqual([SKIP_LINE, "tickmarkr fleet --pick consult: skipped beta:b-hi (beta:b-hi) — denied: routing.deny (beta:b-hi)"]);

    // A missing cache still refuses, naming the doctor command; worker keeps missing-prefer.
    rmSync(join(f.repo, ".tickmarkr", "doctor.json"));
    expect((await pick(f, ["--pick", "consult"])).refused)
      .toEqual({ code: 1, out: "tickmarkr fleet --pick consult: consult.prefer: probe data missing — run tickmarkr doctor first" });
    expect((await pick(f, ["--pick", "worker"])).refused).toEqual({ code: 1, out: "tickmarkr fleet --pick worker: worker.prefer: missing-prefer" });
  });

  test("a judge or review pick without an author exits with code two and the context required line", async () => {
    const f = fixture({ ...CONSULT, review: { prefer: ["gamma", "alpha:a-hi"] } });
    writeCache(f.repo, 5 * MINUTE);
    for (const role of ["judge", "review"]) {
      // The production command function: exit 2, stdout empty, exactly the one stderr line.
      const direct = await pick(f, ["--pick", role]);
      expect(direct.refused).toEqual({ code: 2, out: "" });
      expect(direct.err).toEqual([CONTEXT_LINE(role)]);
      // The CLI dispatcher keeps the exit code, and an empty out prints nothing on stdout.
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const dispatched = await dispatch("fleet", ["--pick", role, "--global-dir", f.globalDir]);
      const written = stderr.mock.calls.map(([chunk]) => String(chunk));
      stderr.mockRestore();
      expect(dispatched).toEqual({ out: "", code: 2 });
      expect(written).toEqual([`${CONTEXT_LINE(role)}\n`]);
    }
    // --author belongs to judge and review only.
    for (const role of ["worker", "consult"]) {
      expect((await pick(f, ["--pick", role, "--author", "beta:b-hi"])).refused).toEqual({
        code: 1, out: `tickmarkr fleet --pick ${role}: incompatible options — --author applies only to --pick judge or review`,
      });
    }
  });

  test("a judge or review pick with an author returns the seat the run would choose for that author", async () => {
    // Review: the review gate's first round for the author — its floor, review.prefer, no rotation history.
    const f = fixture({ ...CONSULT, review: { prefer: ["gamma", "alpha:a-hi"] } });
    const health = writeCache(f.repo, 5 * MINUTE);
    const cfg = f.cfg();
    const pools = rolePools(cfg, ADAPTERS, health);
    const author = FLEET.beta![0]!;
    const authors = [channelKey(author)];
    const gateReviewer = (exclude: string[]) => pickReviewer(
      author, pools.review, [], cfg.review.prefer ?? [], gateReviewerFloor({}, cfg, author, pools.review).floor,
      [], undefined, new Set(), new Set([...carriedAuthorVendors(pools.review, authors), ...exclude]), authors,
    );
    for (const exclude of [[], ["vc"]]) {
      const got = await pick(f, ["--pick", "review", "--author", "beta:b-hi", ...exclude.flatMap((v) => ["--exclude-vendor", v])]);
      const expected = gateReviewer(exclude)!;
      expect(got.receipt).toMatchObject({ role: "review", adapter: expected.adapter, model: expected.model, vendor: expected.vendor });
      expect(got.receipt!.judgeIndependent).toBeUndefined();
    }
    const excluded = await pick(f, ["--pick", "review", "--author", "beta:b-hi", "--exclude-vendor", "vc"]);
    expect(excluded.receipt).toMatchObject({ adapter: "alpha", model: "a-hi", skips: [{ entry: "gamma", channel: "gamma:c-hi", reason: "excluded-vendor", detail: "vc" }] });
    expect(excluded.err).toEqual(["tickmarkr fleet --pick review: skipped gamma (gamma:c-hi) — excluded-vendor: vc"]);
    // An author no configured channel matches is refused, never a guessed vendor.
    expect((await pick(f, ["--pick", "review", "--author", "nope:x"])).refused).toMatchObject({ code: 1, out: expect.stringContaining("unknown-author") });

    // Judge: the run's primary judge (the first seat runGates' acceptance judge dispatches) for that author —
    // the configured judge shares the author's vendor, so the independent automatic pick; then, with no
    // independent judge left, the same-vendor fallback annotated judgeIndependent: false by the run's own
    // independence predicate over the run's pools (run-gates annotates a parseable verdict the same way).
    for (const [routing, independent] of [[undefined, true], [{ deny: { adapters: ["alpha", "gamma"] } }, false]] as const) {
      const j = fixture({ ...CONSULT, judge: { adapter: "beta", model: "b-mid" } }, routing ? { routing } : {});
      const h = writeCache(j.repo, 5 * MINUTE);
      const got = await pick(j, ["--pick", "judge", "--author", "beta:b-hi"]);
      const primary = await runJudge(j.cfg(), h, author);
      expect(got.receipt).toMatchObject({ role: "judge", skips: [], cache: { stale: false } });
      expect(`${got.receipt!.adapter}:${got.receipt!.model}`).toBe(primary);
      expect(primary).toBe(independent ? "alpha:a-hi" : "beta:b-mid");
      const jp = rolePools(j.cfg(), ADAPTERS, h);
      const seats = [...jp.judge, ...jp.review];
      const seat = seats.find((c) => channelKey(c) === primary)!;
      expect(isIndependentJudge(seat, carriedAuthorVendors(seats, authors), authors)).toBe(independent);
      expect(got.receipt!.judgeIndependent).toBe(independent ? undefined : false);
    }

    // The receipt names vendor and channel for every judge the run would seat, the configured judge outside
    // the eligible pools included (the run dispatches its pin either way). Closed table of the configured
    // judge beta:b-hi's cached state, author alpha:a-hi of another vendor, so the pin is the primary.
    const configured = ADAPTERS.flatMap((a) => a.channels(loadConfig(f.repo, { globalDir: f.globalDir }))).find((c) => channelKey(c) === "beta:b-hi")!;
    const states: [string, (h: Record<string, AuthHealth>) => void, boolean][] = [
      ["authed, in the pools", () => {}, true],
      ["model unauthed", (h) => { h.beta!.modelAuth!["b-hi"] = { ...h.beta!.modelAuth!["b-hi"]!, authed: false, reason: "HTTP 403" }; }, false],
      ["adapter unauthed", (h) => { h.beta!.authed = false; }, false],
      ["adapter not installed", (h) => { h.beta!.installed = false; }, false],
    ];
    for (const [state, edit, inPools] of states) {
      const j = fixture({ ...CONSULT, judge: { adapter: "beta", model: "b-hi" } });
      const h = writeCache(j.repo, 5 * MINUTE, edit);
      const got = await pick(j, ["--pick", "judge", "--author", "alpha:a-hi"]);
      const jp = rolePools(j.cfg(), ADAPTERS, h);
      const seats = [...jp.judge, ...jp.review];
      const seat = seats.find((c) => channelKey(c) === "beta:b-hi");
      expect(!!seat, state).toBe(inPools);
      expect(`${got.receipt?.adapter}:${got.receipt?.model}`, state).toBe(await runJudge(j.cfg(), h, FLEET.alpha![0]!));
      expect(got.receipt, state).toMatchObject({ role: "judge", adapter: "beta", model: "b-hi", vendor: configured.vendor, channel: configured.channel });
      expect([got.receipt!.vendor, got.receipt!.channel], state).toEqual(["vb", "api"]);
      // The run's annotation for this seat (run-gates: a judge outside its channels is not independent), unchanged.
      const runIndependent = !!seat && isIndependentJudge(seat, carriedAuthorVendors(seats, ["alpha:a-hi"]), ["alpha:a-hi"]);
      expect(got.receipt!.judgeIndependent, state).toBe(runIndependent ? undefined : false);
    }
    // A pin no configured channel describes has no vendor or channel to report: refused, never half a receipt.
    const ghost = fixture({ ...CONSULT, judge: { adapter: "beta", model: "b-ghost" } });
    writeCache(ghost.repo, 5 * MINUTE);
    expect((await pick(ghost, ["--pick", "judge", "--author", "alpha:a-hi"])).refused).toEqual({
      code: 1, out: "tickmarkr fleet --pick judge: beta:b-ghost names no configured channel — its vendor and channel are unknown",
    });
  });

  test("fleet help documents the author flag the context required exit code the skip lines and the stale cache report", async () => {
    const help = commandHelp("fleet");
    expect((await dispatch("fleet", ["--help"])).out).toBe(help);
    expect(help).toContain("--author <adapter:model>  The worker whose diff the judge or review seat would judge");
    expect(help).toContain("Judge and review require --author: without it the pick exits 2 with stdout empty and one stderr context-required line.");
    expect(help).toContain("each skipped preference also prints one stderr line `skipped <entry> (<channel>) — <reason>: <detail>`");
    expect(help).toContain("The doctor cache is read at any age: a cache 60 minutes or older is reported stale in the JSON and by one stderr line `doctor cache is <age> old (stale)`");
    expect(help).toContain("The JSON adds skips and cache { ageMs, stale }");
    // The documented words are the ones the command prints.
    expect(CONTEXT_LINE("judge")).toContain("context-required");
    expect(STALE_LINE).toContain("doctor cache is 180m old (stale)");
    expect(SKIP_LINE).toMatch(/: skipped \S+ \(\S+\) — \S+: /);
  });
});

/** The run's acceptance judge on a one-commit diff; every stub answers unparseably, so the primary is the first seat dispatched. */
async function runJudge(cfg: ReturnType<typeof loadConfig>, health: Record<string, AuthHealth>, author: BillingChannel) {
  const repo = tmp("judge");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "pick@test.local"]);
  git(["config", "user.name", "pick"]);
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "a.txt"), "y\n");
  git(["commit", "-q", "-am", "work", "--no-gpg-sign"]);
  const task = validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: ["build", "test", "lint", "evidence", "scope", "acceptance"], files: [] }],
  }).tasks[0]!;
  const pools = rolePools(cfg, ADAPTERS, health);
  calls.length = 0;
  const { results } = await runGates(task, {
    worktree: repo, baseRef: base,
    author: { adapter: author.adapter, model: author.model, channel: author.channel, tier: author.tier },
    result: { ok: true, summary: "", deviations: [], raw: "" },
    commands: {}, baseline: await captureBaseline(repo, {}),
    channels: pools.review, judgeChannels: pools.judge, health, adapters: ADAPTERS, cfg,
  } as Parameters<typeof runGates>[1]);
  expect(results.find((r) => r.gate === "acceptance")).toBeDefined();
  return calls[0];
}
