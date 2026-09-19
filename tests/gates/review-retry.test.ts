// OBS-193: an unparseable review verdict retries the REVIEW exactly once on a different reviewer —
// never the worker (GATE-09's judge-retry shape). The flaked verdict never enters results. OBS-196:
// an unparseable result names its cause (empty-output / no-verdict / malformed-verdict) and persists
// the raw reviewer output beside the journal, so a ruled-on "unparseable" can be audited and a
// reviewer cutoff is never indistinguishable from a parse defect.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type Assignment, type BillingChannel } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { gateReviewerFloor, pickReviewer, reviewGate } from "../../src/gates/review.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

// command-typed acceptance keeps the judge deterministic (no fake-judge subprocess per round —
// the daemon round-cap test's pattern); review is the gate under test.
const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: [{ oracle: "command", command: "true" }], ...over }],
  }).tasks[0];

function scriptWith(extra: object): string {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-rev-retry-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...extra }));
  return p;
}

// id ≠ "fake" ⇒ llm.ts never nonce-augments its output ⇒ a nonce-less verdict is unparseable,
// exactly like a real CLI emitting a verdict that fails the nonce test.
class GarbageReviewer extends FakeAdapter {
  id = "fake-b";
  vendor = "fake-vb";
}

// a reviewer that emits NOTHING — the OBS-196 cutoff shape.
class SilentReviewer extends FakeAdapter {
  id = "fake-b";
  vendor = "fake-vb";
  headlessCommand(): string {
    return "true";
  }
}

// binds the served review verdict to the prompt's nonce itself (the judge-retry FakeAdapterB
// pattern) — a parseable second seat for the retry to land on.
class BindingReviewer extends FakeAdapter {
  id = "fake-c";
  vendor = "fake-vc";
  calls = 0;
  private cPath: string;

  constructor(scriptPath: string) {
    super(scriptPath);
    this.cPath = scriptPath;
  }

  headlessCommand(promptFile: string, model: string): string {
    this.calls++;
    const base = super.headlessCommand(promptFile, model);
    const nodeScript = `(function(){
      const fs = require("fs");
      const path = require("path");
      const prompt = fs.readFileSync(${JSON.stringify(promptFile)}, "utf8");
      const nonce = (prompt.match(/VERDICT_NONCE:\\s*([0-9a-f]+)/i) || [])[1];
      if (!nonce) return;
      if (!/TICKMARKR-REVIEW/.test(prompt)) return;
      try {
        const file = path.join(path.dirname(${JSON.stringify(this.cPath)}), "review.json");
        const obj = JSON.parse(fs.readFileSync(file, "utf8"));
        if (obj && typeof obj === "object" && !obj.nonce) {
          process.stdout.write("\\n" + JSON.stringify({ ...obj, nonce }));
        }
      } catch {}
    })()`;
    return `${base}; node -e ${shq(nodeScript)}`;
  }
}

// second garbage seat for the double-garbage case — same nonce-less unparseable shape as fake-b.
class GarbageReviewerC extends FakeAdapter {
  id = "fake-c";
  vendor = "fake-vc";
}

// RF-1 daemon path: a worker seat at mid, and review seats serving a nonce-bound verdict — "material"
// re-raises every carried fingerprint beside a blocking finding, "approve" resolves them — so a real
// run's second round is decided by whichever seat the daemon draws.
class MidAuthor extends FakeAdapter {
  override channels(): BillingChannel[] {
    return [{ adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "mid" }];
  }
}

class DaemonSeat extends FakeAdapter {
  calls = 0;
  constructor(path: string, public override id: string, private seatTier: Assignment["tier"], private mode: "material" | "approve") {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    // api costs more than the author's sub seat, so worker routing never picks a review seat
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: this.seatTier }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    if (!/TICKMARKR-REVIEW/.test(prompt)) return "true";
    this.calls++;
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)![1];
    const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
    const verdict = this.mode === "approve"
      ? { nonce, approve: true, resolved: carried, reraised: [], findings: [] }
      : { nonce, approve: false, resolved: [], reraised: carried, findings: [{ note: "src/work.ts:1 drops the last row", severity: "material" }] };
    return `printf '%s' ${shq(JSON.stringify(verdict))}`;
  }
}

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const chAuthor: BillingChannel = { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" };
// frontier sorts before mid in pickReviewer, so fake-b is always the FIRST seat drawn.
const chGarbage: BillingChannel = { adapter: "fake-b", vendor: "fake-vb", model: "fake-b-1", channel: "sub", tier: "frontier" };
// RF-1: fake-c sits at the author's tier — a reviewer is never seated below its author or a prior reviewer.
const chSecond: BillingChannel = { adapter: "fake-c", vendor: "fake-vc", model: "fake-c-1", channel: "sub", tier: "frontier" };
const chMidSecond: BillingChannel = { ...chSecond, tier: "mid" };

function repoWithCommit() {
  const repo = makeRepo({ "a.txt": "x\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

const gateCtx = async (repo: string, base: string, adapters: FakeAdapter[], channels: BillingChannel[], events?: GateEvent[]) => ({
  worktree: repo,
  baseRef: base,
  result: { ok: true, summary: "s", deviations: [], raw: "" },
  author,
  commands: {},
  baseline: await captureBaseline(repo, {}),
  channels,
  adapters,
  // judge resolves within the fake fleet if it ever dispatches (command-typed acceptance keeps it dormant)
  cfg: { ...DEFAULT_CONFIG, judge: { ...DEFAULT_CONFIG.judge, adapter: "fake", model: "fake-1" } },
  ...(events ? { onGate: (e: GateEvent) => { events.push(e); } } : {}),
});

describe("review retry — unparseable verdict re-asks a different reviewer, never the worker (OBS-193)", () => {
  test("test: after a review flake the retry picks a channel of a different adapter when one is installed and authed and picks a same-adapter channel only when no other adapter has an eligible seat and the gate row's re-route text and reviewRetry meta say which whereas the shipped retry that excludes only the flaked channel key fails", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const replacement = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const firstRepo = repoWithCommit();
    const first = await runGates(
      mkTask(),
      await gateCtx(firstRepo.repo, firstRepo.base, [worker, garbage, replacement], [chAuthor, chGarbage, chSecond]),
    );
    const cross = first.results.find((result) => result.gate === "review")!;
    expect(cross.meta?.reviewRetry).toMatchObject({ retried: "fake-c:fake-c-1", exclusion: "adapter" });
    expect(cross.details).toMatch(/different-adapter retry; excluded flaked adapter fake-b/);

    const sameRepo = repoWithCommit();
    const sameChannels: BillingChannel[] = [
      chAuthor,
      chGarbage,
      { ...chGarbage, model: "fake-b-2" },
    ];
    const same = await runGates(
      mkTask(),
      await gateCtx(sameRepo.repo, sameRepo.base, [worker, garbage], sameChannels),
    );
    const fallback = same.results.find((result) => result.gate === "review")!;
    expect(fallback.meta?.reviewRetry).toMatchObject({ retried: "fake-b:fake-b-2", exclusion: "channel" });
    expect(fallback.details).toMatch(/same-adapter fallback; excluded flaked channel fake-b:fake-b-1/);
  });

  test("test: a reviewer that answers with a genuine request for changes carries no infrastructure marking however its verdict is shaped, so a real rejection still charges the worker; a repair marking every failing review as infrastructure launders a red into a park and: it fails", async () => {
    const { repo, base } = repoWithCommit();
    const legacy = new BindingReviewer(scriptWith({ review: { approve: false, issues: ["real defect"] } }));
    const classified = new BindingReviewer(scriptWith({
      review: { approve: true, findings: [{ note: "real defect", severity: "material", defer: false }] },
    }));

    for (const reviewer of [legacy, classified]) {
      const result = await reviewGate(
        mkTask(), repo, base, author, [chAuthor, chSecond], [new FakeAdapter(scriptWith({})), reviewer], DEFAULT_CONFIG,
      );
      expect(result.pass).toBe(false);
      expect(result.details).toMatch(/real defect/);
      expect(result.meta?.infra).toBeUndefined();
      expect(result.meta?.classification).not.toBe("infra");
    }
  });

  test("test: when a silent seat is replaced the review result's own recorded text names the seat that went silent and the seat that replaced it, so the journaled row a reader opens says a re-route happened; a re-route recorded only in a field the row never carries leaves that row silent and: it fails", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const silent = new SilentReviewer(scriptWith({}));
    const replacement = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const { repo, base } = repoWithCommit();
    const { results } = await runGates(
      mkTask(),
      await gateCtx(repo, base, [worker, silent, replacement], [chAuthor, chGarbage, chSecond]),
    );
    const review = results.find((result) => result.gate === "review")!;
    const journaledRow = { gate: review.gate, pass: review.pass, details: review.details };

    expect(review.pass).toBe(true);
    expect(journaledRow.details).toContain("fake-b:fake-b-1");
    expect(journaledRow.details).toContain("fake-c:fake-c-1");
    expect(journaledRow.details).toMatch(/re-route/);
  });

  test("test: a task declaring a frontier floor is graded only at or above that tier, and where the diversity rules leave no such seat the gate fails closed naming the floor as the reason; a picker that sorts by tier without refusing below it still seats a mid-tier grader after the frontier seat flakes and: it fails", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const flakedFrontier = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const midReplacement = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const channels = [chAuthor, chGarbage, chMidSecond];
    const task = mkTask({ routingHints: { floor: "frontier" } });
    const { repo, base } = repoWithCommit();

    expect(pickReviewer(author, channels, ["fake-b:fake-b-1"], [], "frontier")).toBeNull();
    const { results } = await runGates(
      task,
      await gateCtx(repo, base, [worker, flakedFrontier, midReplacement], channels),
    );
    const review = results.find((result) => result.gate === "review")!;
    expect(review.pass).toBe(false);
    expect(review.details).toMatch(/frontier floor/);
    expect(review.meta?.reviewer).toBe("fake-b:fake-b-1");
    expect(midReplacement.calls).toBe(0);
  });

  test("test: a task declaring no floor selects the same reviewer it selects today and the existing single cross-channel replacement keeps its seat, so the floor is opt-in; a floor taken from config for every task moves seats on tasks that declared nothing and: it fails", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const flakedFrontier = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const midReplacement = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const channels = [chAuthor, chGarbage, chSecond];
    const task = mkTask();
    const { repo, base } = repoWithCommit();
    const ctx = await gateCtx(repo, base, [worker, flakedFrontier, midReplacement], channels);
    const cfg = structuredClone(ctx.cfg);
    cfg.routing.floors.implement = "frontier";

    expect(task.routingHints?.floor).toBeUndefined();
    expect(pickReviewer(author, channels)).toEqual(chGarbage);
    const { results } = await runGates(task, { ...ctx, cfg });
    const review = results.find((result) => result.gate === "review")!;
    expect(review.pass).toBe(true);
    expect(review.meta?.reviewRetry).toEqual({
      flaked: "fake-b:fake-b-1",
      retried: "fake-c:fake-c-1",
      exclusion: "adapter",
    });
    expect(midReplacement.calls).toBe(1);
  });

  test("garbage first seat → retried once on the second seat; the flaked verdict never enters results", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } })); // nonce-less ⇒ unparseable
    const good = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const { repo, base } = repoWithCommit();
    const events: GateEvent[] = [];
    const { results } = await runGates(mkTask(), await gateCtx(repo, base, [worker, garbage, good], [chAuthor, chGarbage, chSecond], events));
    const reviews = results.filter((r) => r.gate === "review");
    expect(reviews).toHaveLength(1); // exactly-once: flaked verdict replaced, not appended
    expect(reviews[0]!.pass).toBe(true);
    expect(reviews[0]!.meta?.reviewRetry).toEqual({ flaked: "fake-b:fake-b-1", retried: "fake-c:fake-c-1", exclusion: "adapter" });
    expect(events.filter((e) => e.phase === "end" && e.gate === "review")).toHaveLength(1); // no false gate event
  });

  // T4 (OBS-265): the round's shape changed, the seam did not. Under the v1.85 pipeline the review is
  // launched beside the judge instead of after it — an unparseable first seat still costs exactly one
  // in-gate re-ask, and the flaked verdict still never enters results.
  test("the retry seam is unchanged when review runs beside the judge", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const good = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const { repo, base } = repoWithCommit();
    const events: GateEvent[] = [];
    const ctx = await gateCtx(repo, base, [worker, garbage, good], [chAuthor, chGarbage, chSecond], events);
    const { results } = await runGates(mkTask(), ctx);
    const reviews = results.filter((r) => r.gate === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.pass).toBe(true);
    expect(reviews[0]!.meta?.reviewRetry).toEqual({ flaked: "fake-b:fake-b-1", retried: "fake-c:fake-c-1", exclusion: "adapter" });
    expect(events.filter((e) => e.phase === "end" && e.gate === "review")).toHaveLength(1);
    // and the two verdict gates really were one round: same parent, both started before either ended
    const starts = events.filter((e) => e.phase === "start" && (e.gate === "acceptance" || e.gate === "review"));
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((e) => (e as { parentAt?: number }).parentAt)).size).toBe(1);
  });

  test("double garbage fails closed exactly like today, with the retry attributed", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const garbageC = new GarbageReviewerC(scriptWith({ review: { approve: true } }));
    const { repo, base } = repoWithCommit();
    const { results } = await runGates(mkTask(), await gateCtx(repo, base, [worker, garbage, garbageC], [chAuthor, chGarbage, chSecond]));
    const review = results.find((r) => r.gate === "review");
    expect(review?.pass).toBe(false);
    expect(review?.meta?.unparseable).toBeUndefined();
    expect(review?.meta?.reviewRetry).toEqual({ flaked: "fake-b:fake-b-1", retried: "fake-c:fake-c-1", exclusion: "adapter" });
  });

  test("no second eligible seat keeps the ORIGINAL unparseable result — the recorded cause stays truthful", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const { repo, base } = repoWithCommit();
    const { results } = await runGates(mkTask(), await gateCtx(repo, base, [worker, garbage], [chAuthor, chGarbage]));
    const review = results.find((r) => r.gate === "review");
    expect(review?.pass).toBe(false);
    expect(String(review?.details)).toMatch(/no structurally valid nonce-bound response/);
    expect(review?.meta?.reviewRetry).toBeUndefined(); // never a synthetic no-reviewer failure
  });
});

// RF-1 (OBS-922 add.2/3): the reviewer floor is max(author tier, task floor, review.floor tier, prior
// reviewer's tier); the gate names the resolved floor and its cause, and fails closed when no seat meets it.
describe("reviewer floor — max(author tier, task floor, review.floor, prior reviewer)", () => {
  const at = (tier: Assignment["tier"]) => ({ author: { ...author, tier }, channel: { ...chAuthor, tier } });
  const cheapB: BillingChannel = { ...chGarbage, tier: "cheap" };
  const midB: BillingChannel = { ...chGarbage, tier: "mid" };
  const frontierC: BillingChannel = chSecond;
  const midC: BillingChannel = chMidSecond;
  const frontierCfg = () => { const cfg = structuredClone(DEFAULT_CONFIG); cfg.review.floor = "frontier"; return cfg; };
  const midCfg = () => { const cfg = structuredClone(DEFAULT_CONFIG); cfg.review.floor = "mid"; return cfg; };

  test("test: a mid author with cross-vendor cheap and frontier channels seats the frontier reviewer, a mid author whose only cross-vendor channels are cheap yields no reviewer and the gate fails closed naming the resolved floor mid and its cause, and review.floor frontier over a cheap author seats a frontier reviewer only, so a reviewer seated below the author's tier fails", async () => {
    const mid = at("mid");
    expect(pickReviewer(mid.author, [mid.channel, cheapB, frontierC])).toBe(frontierC);
    // the picker applies the author's tier by itself — no floor argument, default review.floor worker
    expect(pickReviewer(mid.author, [mid.channel, cheapB])).toBeNull();

    const seatC = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const { repo, base } = repoWithCommit();
    const noSeat = await reviewGate(mkTask(), repo, base, mid.author, [mid.channel, cheapB], [seatC], structuredClone(DEFAULT_CONFIG));
    expect(noSeat.pass).toBe(false);
    expect(noSeat.details).toMatch(/at or above mid floor \(author-tier/);
    expect(noSeat.meta).toMatchObject({ noEligibleReviewer: true, reviewerFloor: "mid", reviewerFloorCause: "author-tier" });
    // review.floor mid over a mid author is attributed to the author (it raised nothing)
    const midOverMid = await reviewGate(mkTask(), repo, base, mid.author, [mid.channel, cheapB], [seatC], midCfg());
    expect(midOverMid.meta).toMatchObject({ noEligibleReviewer: true, reviewerFloor: "mid", reviewerFloorCause: "author-tier" });

    const cheap = at("cheap");
    const seated = await reviewGate(mkTask(), repo, base, cheap.author, [cheap.channel, midB, frontierC], [seatC], frontierCfg());
    expect(seated.pass).toBe(true);
    expect(seated.meta).toMatchObject({ reviewer: "fake-c:fake-c-1", reviewerFloor: "frontier", reviewerFloorCause: "config" });
    const refused = await reviewGate(mkTask(), repo, base, cheap.author, [cheap.channel, midB], [seatC], frontierCfg());
    expect(refused.pass).toBe(false);
    expect(refused.details).toMatch(/at or above frontier floor \(config/);
    expect(refused.meta).toMatchObject({ reviewerFloor: "frontier", reviewerFloorCause: "config" });
    // a task floor above the config tier wins and is named as the cause
    const taskWins = await reviewGate(mkTask({ routingHints: { floor: "frontier" } }), repo, base, cheap.author, [cheap.channel, midB], [seatC], midCfg());
    expect(taskWins.meta).toMatchObject({ reviewerFloor: "frontier", reviewerFloorCause: "task-floor" });
  });

  test("test: a second review round and the retry after an unparseable verdict each seat a reviewer whose tier is at or above the prior reviewer's tier and the row's meta names the resolved floor and its cause, so a retry that drops to a lower tier fails", async () => {
    const cheap = at("cheap");
    const seatC = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const { repo, base } = repoWithCommit();
    // second round under DEFAULT review.floor worker: THIS task's prior reviewer is frontier fake-b (named
    // as task-scoped prior-reviewer evidence, the last positional arg, and excluded so fake-c is drawn);
    // a mid fake-c cannot follow it — the prior reviewer's tier is the floor and is named as the cause.
    const prior = ["fake-b:fake-b-1"];
    expect(gateReviewerFloor(mkTask(), DEFAULT_CONFIG, cheap.author, [cheap.channel, chGarbage, midC], prior)).toEqual({ floor: "frontier", cause: "prior-reviewer" });
    const round2 = (chs: BillingChannel[], history: string[]) => reviewGate(mkTask(), repo, base, cheap.author, chs, [seatC],
      structuredClone(DEFAULT_CONFIG), undefined, prior, undefined, history, undefined, [], prior);
    const dropped = await round2([cheap.channel, chGarbage, midC], []);
    expect(dropped.pass).toBe(false);
    expect(dropped.meta).toMatchObject({ noEligibleReviewer: true, reviewerFloor: "frontier", reviewerFloorCause: "prior-reviewer" });
    const held = await round2([cheap.channel, chGarbage, frontierC], []);
    expect(held.pass).toBe(true);
    expect(held.meta).toMatchObject({ reviewer: "fake-c:fake-c-1", reviewerFloor: "frontier", reviewerFloorCause: "prior-reviewer" });
    // the run-scoped LRU history alone (a frontier seat some OTHER task used) never ratchets this task's
    // floor: a cheap author with only a mid cross-vendor seat still seats it
    const unrelated = await reviewGate(mkTask(), repo, base, cheap.author, [cheap.channel, midC], [seatC],
      structuredClone(DEFAULT_CONFIG), undefined, undefined, undefined, ["fake-b:fake-b-1"]);
    expect(unrelated.pass).toBe(true);
    expect(unrelated.meta).toMatchObject({ reviewer: "fake-c:fake-c-1", reviewerFloor: "cheap", reviewerFloorCause: "author-tier" });
    // a prior reviewer's DISPATCHED tier is historical evidence, read independently of the current pool:
    // round 1's frontier seat has left the pool, yet the mid seat still cannot follow it
    const gone = await reviewGate(mkTask(), repo, base, cheap.author, [cheap.channel, midC], [seatC],
      structuredClone(DEFAULT_CONFIG), undefined, undefined, undefined, [], undefined, [], [{ reviewer: "previous:frontier", tier: "frontier" }]);
    expect(gone.pass).toBe(false);
    expect(gone.meta).toMatchObject({ noEligibleReviewer: true, reviewerFloor: "frontier", reviewerFloorCause: "prior-reviewer" });
    // a recorded tier is taken as recorded; a prior seat whose tier nothing establishes holds frontier (fail closed)
    expect(gateReviewerFloor(mkTask(), DEFAULT_CONFIG, cheap.author, [cheap.channel, midC], [{ reviewer: "previous:mid", tier: "mid" }])).toEqual({ floor: "mid", cause: "prior-reviewer" });
    expect(gateReviewerFloor(mkTask(), DEFAULT_CONFIG, cheap.author, [cheap.channel, midC], ["previous:unknown"])).toEqual({ floor: "frontier", cause: "prior-reviewer" });
    expect(gateReviewerFloor(mkTask(), DEFAULT_CONFIG, cheap.author, [cheap.channel, midC], [{ reviewer: "previous:garbage", tier: "fronteir" }])).toEqual({ floor: "frontier", cause: "prior-reviewer" });

    // the REAL daemon path under default review.floor: round 1's frontier seat-a raises a material; the
    // repair round must not rotate to the unused mid seat-b a mid author would otherwise admit — the daemon
    // hands the gate this task's journaled reviewers, so seat-a is re-seated and the journal row names why.
    const daemonRun = setupRepo(
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      { tasks: { T1: [{ shell: `echo v >> f.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] } },
      `concurrency: 1\nrouting:\n  escalateTier: "off"\nreview: { required: true, prefer: [seat-a, seat-b], timeoutMs: 60000 }\n`,
    );
    const seatA = new DaemonSeat(daemonRun.scriptPath, "seat-a", "frontier", "material");
    const seatB = new DaemonSeat(daemonRun.scriptPath, "seat-b", "mid", "approve");
    const summary = await runDaemon(daemonRun.repo, { adapters: [new MidAuthor(daemonRun.scriptPath), seatA, seatB], runId: "run-rf1-round2" });
    expect(summary.human).toEqual(["T1"]);
    expect([seatA.calls, seatB.calls]).toEqual([2, 0]);
    const reviewRows = Journal.open(daemonRun.repo, "run-rf1-round2").read()
      .filter((row) => row.event === "gate-result" && row.data.gate === "review");
    expect(reviewRows.map((row) => [row.data.reviewer, row.data.reviewerTier, row.data.reviewerFloor, row.data.reviewerFloorCause])).toEqual([
      ["seat-a:seat-a", "frontier", "mid", "author-tier"],
      ["seat-a:seat-a", "frontier", "frontier", "prior-reviewer"],
    ]);
    // RESUME with seat-a gone from the fleet: the pool is rebuilt without it, but its journaled dispatch
    // tier still holds the floor. The repair round's pool holds only mid channels (whichever of fake-1 or
    // seat-b authors it, the other is a mid cross-vendor seat), so no reviewer is seated and it fails closed
    await approve(["run-rf1-round2", "T1", "--uphold", "--review-rounds", "1", "--by", "operator"], daemonRun.repo);
    const resumed = await runDaemon(daemonRun.repo, { adapters: [new MidAuthor(daemonRun.scriptPath), seatB], runId: "run-rf1-round2", resume: true });
    expect(resumed.done).not.toContain("T1");
    expect(seatB.calls).toBe(0);
    const resumedReview = Journal.open(daemonRun.repo, "run-rf1-round2").read()
      .filter((row) => row.event === "gate-result" && row.data.gate === "review").at(-1)!;
    expect(resumedReview.data.pass).toBe(false);
    expect(resumedReview.data.reviewer).toBeUndefined();
    expect(JSON.stringify(resumedReview.data)).toMatch(/at or above frontier floor \(prior-reviewer/);

    // retry after an unparseable verdict under default review.floor: frontier fake-b flakes; mid fake-c is
    // refused (the flaked reviewer's tier holds the floor), frontier fake-c seats
    const worker = new FakeAdapter(scriptWith({}));
    for (const [second, expectPass] of [[midC, false], [frontierC, true]] as const) {
      const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } }));
      const replacement = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
      const r = repoWithCommit();
      const ctx = await gateCtx(r.repo, r.base, [worker, garbage, replacement], [cheap.channel, chGarbage, second]);
      const { results } = await runGates(mkTask(), { ...ctx, author: cheap.author });
      const review = results.find((result) => result.gate === "review")!;
      expect(review.pass).toBe(expectPass);
      expect(replacement.calls).toBe(expectPass ? 1 : 0);
      if (expectPass) {
        expect(review.meta).toMatchObject({ reviewRetry: { flaked: "fake-b:fake-b-1", retried: "fake-c:fake-c-1" }, reviewerFloor: "frontier", reviewerFloorCause: "prior-reviewer" });
      } else {
        expect(review.meta?.reviewRetry).toBeUndefined();
        expect(review.details).toMatch(/re-route refused: .*at or above frontier floor \(prior-reviewer/);
        // the refused retry's resolved floor lands in the row's meta, not only in details
        expect(review.meta).toMatchObject({ reviewer: "fake-b:fake-b-1", reviewerFloor: "frontier", reviewerFloorCause: "prior-reviewer" });
      }
    }
  }, 120_000);

  test("an in-gate retry holds the flaked seat's own tier, never the tier of an unused channel excluded only because it shares the flaked adapter (RF-1)", async () => {
    // mid fake-b-1 flakes; frontier fake-b-2 shares its adapter and is banned with it but never reviewed,
    // so the retry floor is mid (the flaked seat), and mid fake-c on another adapter is seated
    const cheap = at("cheap");
    const frontierB2: BillingChannel = { ...chGarbage, model: "fake-b-2" };
    const worker = new FakeAdapter(scriptWith({}));
    const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const replacement = new BindingReviewer(scriptWith({ review: { approve: true, issues: [] } }));
    const { repo, base } = repoWithCommit();
    const ctx = await gateCtx(repo, base, [worker, garbage, replacement], [cheap.channel, midB, frontierB2, midC]);
    const cfg = { ...ctx.cfg, review: { ...ctx.cfg.review, prefer: ["fake-b:fake-b-1"] } };
    const { results } = await runGates(mkTask(), { ...ctx, author: cheap.author, cfg });
    const review = results.find((result) => result.gate === "review")!;
    expect(review.pass).toBe(true);
    expect(replacement.calls).toBe(1);
    expect(review.meta).toMatchObject({
      reviewRetry: { flaked: "fake-b:fake-b-1", retried: "fake-c:fake-c-1", exclusion: "adapter" },
      reviewerFloor: "mid", reviewerFloorCause: "prior-reviewer",
    });
  });
});

describe("unparseable cause + raw persistence (OBS-196)", () => {
  test("a nonce-less verdict is cause no-verdict, and the raw bytes land beside the journal", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const garbage = new GarbageReviewer(scriptWith({ review: { approve: true } }));
    const { repo, base } = repoWithCommit();
    const artifactDir = mkdtempSync(join(tmpdir(), "tickmarkr-rev-raw-"));
    const r = await reviewGate(mkTask(), repo, base, author, [chAuthor, chGarbage], [worker, garbage], DEFAULT_CONFIG, undefined, [], artifactDir);
    expect(r.pass).toBe(false);
    expect(r.meta?.unparseable).toBeUndefined();
    expect(r.meta?.cause).toBe("no-verdict");
    expect(String(r.details)).toMatch(/cause: no-verdict/);
    const files = readdirSync(artifactDir).filter((f) => f.startsWith("review-raw-T1-"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(artifactDir, files[0]!), "utf8")).toContain("approve");
  });

  test("a reviewer that emits nothing is cause empty-output — a cutoff, not a parse defect", async () => {
    const worker = new FakeAdapter(scriptWith({}));
    const silent = new SilentReviewer(scriptWith({}));
    const { repo, base } = repoWithCommit();
    const r = await reviewGate(mkTask(), repo, base, author, [chAuthor, chGarbage], [worker, silent], DEFAULT_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.meta?.cause).toBe("empty-output");
    expect(String(r.details)).toMatch(/cause: empty-output/);
  });
});
