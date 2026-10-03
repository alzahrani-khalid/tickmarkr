// F (D-832): a proof page is complete only when its OWN paging metadata says so, explicitly and
// consistently (classifyProofPage). Omitted, non-boolean or contradictory flags — and a page that is
// not the stream's scrollback — leave the scrollback unread: never the checkout-proof-timeout
// exemption, while a matching proof on such a page still proves its checkout.
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { classifyProofPage, OrcaDriver, type OrcaExec, OrcaUnavailableError } from "../../src/drivers/orca.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { FakeOrca, pacedReadExec, steppedTime, withheldProofExec } from "../helpers/fake-orca.js";
import { makeRepo } from "../helpers/tmprepo.js";

// How every proof read answers: as recorded (explicit), with paging flags omitted (pacedReadExec's
// omitFlags), or rewritten — a flag that is not a boolean, a "last" page whose next cursor stops short
// of the latest one, or a page whose source is not the stream.
type Shape = "explicit" | "no limited" | "no truncated" | "no flags" | "non-boolean limited" | "non-boolean truncated" | "contradictory" | "unavailable";
const OMITTED: Partial<Record<Shape, ("limited" | "truncated")[]>> = { "no limited": ["limited"], "no truncated": ["truncated"], "no flags": ["limited", "truncated"] };
const REWRITE: Partial<Record<Shape, (term: Record<string, unknown>) => void>> = {
  "non-boolean limited": (term) => { term.limited = String(term.limited); },
  "non-boolean truncated": (term) => { term.truncated = 0; },
  "contradictory": (term) => { term.limited = false; term.latestCursor = `${String(term.nextCursor)}9`; },
  "unavailable": (term) => { term.source = "screen-unavailable"; },
};
const SHAPES: Shape[] = ["explicit", "no limited", "no truncated", "no flags", "non-boolean limited", "non-boolean truncated", "contradictory", "unavailable"];

/** One production create over `checkout` (the fake tracks it): 150 ms proof reads honoring their
 *  budgets, the proof withheld until `atMs` of injected time (never, without it). With `pageSize`, a
 *  seven-row startup banner precedes it, so the proof lands past the first cursor page. */
function rig(checkout: string, shape: Shape, atMs?: number, pageSize?: number) {
  const clock = steppedTime();
  const fake = new FakeOrca({ trackedWorktrees: [checkout], pageSize });
  const seed = pageSize === undefined ? undefined : () => Array.from({ length: 7 }, (_, i) => `banner ${i + 1}`);
  const reads: { at: number; timeoutMs?: number }[] = [];
  let closedAt: number | undefined;
  const paced = pacedReadExec(withheldProofExec(fake, clock, { atMs, seed }), clock, {
    readMs: 150, honor: true, omitFlags: OMITTED[shape], onRead: (r) => reads.push(r),
  });
  const exec: OrcaExec = async (args, cwd, timeoutMs) => {
    if (args[1] === "close") closedAt ??= clock.now();
    const r = await paced(args, cwd, timeoutMs);
    const rewrite = REWRITE[shape];
    if (args[1] !== "read" || rewrite === undefined || r.code !== 0) return r;
    const env = JSON.parse(r.stdout) as { result: { terminal: Record<string, unknown> } };
    rewrite(env.result.terminal);
    return { ...r, stdout: JSON.stringify(env) };
  };
  return { fake, clock, reads, closed: () => closedAt, driver: new OrcaDriver({ exec, time: clock, launchingHandle: "term_launch" }) };
}

test("production Orca create treats omitted limited or truncated nonboolean and contradictory completeness as unread versus explicit complete absence while matching proof at injected 10000 ms remains usable", async () => {
  // The closed seam itself: explicit and consistent metadata is complete or partial; everything else is unread.
  const page = { handle: "h", status: "running", source: "stream", tail: [], oldestCursor: "0", nextCursor: "4", latestCursor: "4" };
  expect(classifyProofPage({ ...page, limited: false, truncated: false })).toBe("complete");
  expect(classifyProofPage({ ...page, limited: false, truncated: true })).toBe("partial");
  expect(classifyProofPage({ ...page, limited: true, truncated: false, nextCursor: "2" })).toBe("partial");
  expect(classifyProofPage({ ...page, limited: true, truncated: false })).toBe("partial"); // the read from the latest cursor settles it
  for (const [name, term] of [
    ["no limited", { ...page, truncated: false }],
    ["no truncated", { ...page, limited: false }],
    ["no flags", page],
    ["non-boolean limited", { ...page, limited: "false", truncated: false }],
    ["non-boolean truncated", { ...page, limited: false, truncated: 0 }],
    ["contradictory", { ...page, limited: false, truncated: false, nextCursor: "2" }],
    ["non-string cursor", { ...page, limited: false, truncated: false, latestCursor: 4 }],
    ["unavailable", { ...page, limited: false, truncated: false, source: "screen-unavailable" }],
    ["blind", { ...page, limited: false, truncated: false, status: "exited", returnedLineCount: 0 }],
  ] as const) expect(classifyProofPage(term as Record<string, unknown>), name).toBe("unread");

  const checkout = "/tmp/orca-proof-pages/T1";
  for (const shape of SHAPES) {
    // No proof ever arrives: an empty scrollback read every poll inside the unchanged 20000 ms ceiling.
    const absent = rig(checkout, shape);
    const slot = await absent.driver.slot(checkout, "proof-pages-absent");
    const error = await absent.driver.run(slot, "review").then(() => undefined, (e: unknown) => e);
    expect(error, shape).toBeInstanceOf(OrcaUnavailableError);
    const refused = error as OrcaUnavailableError;
    expect(refused.message, shape).toMatch(/does not prove checkout \S+ within 20000 ms/);
    for (const r of absent.reads) expect(r.timeoutMs, shape).toBe(20_000 - r.at); // every read inside the ceiling, handed what is left
    expect(absent.closed(), shape).toBe(20_000);
    expect(absent.fake.countOf("close"), shape).toBe(1);
    if (shape === "explicit") {
      // Every page said, explicitly and consistently, that it was the end: genuine absence, the typed timeout.
      expect(refused.launchCause, shape).toBe("checkout-proof-timeout");
      expect(refused.message, shape).toMatch(/within 20000 ms \(its scrollback names no checkout\)/);
    } else {
      // The same empty scrollback without explicit completeness is unread — no exemption, still refused.
      expect(refused.launchCause, shape).toBeUndefined();
      expect(refused.message, shape).toMatch(/within 20000 ms \(a page carried missing, non-boolean or contradictory paging metadata, its scrollback names no checkout\)/);
    }
    await expect(absent.driver.run(slot, "again"), shape).rejects.toBeInstanceOf(OrcaUnavailableError); // latched
    expect(absent.fake.countOf("create"), shape).toBe(1);

    // The matching proof first arriving at injected 10000 ms proves the checkout whatever the flags say.
    const late = rig(checkout, shape, 10_000);
    const lateSlot = await late.driver.slot(checkout, "proof-pages-late");
    await expect(late.driver.run(lateSlot, "review"), shape).resolves.toBeUndefined();
    expect(late.clock.now(), shape).toBeGreaterThanOrEqual(10_000);
    expect(late.clock.now(), shape).toBeLessThan(20_000);
    expect(late.closed(), shape).toBeUndefined();
    expect(late.fake.countOf("create"), shape).toBe(1);

    // Behind a banner on 2-row pages the proof lies past the first cursor page: a page whose completeness
    // is unknown still hands on an advancing cursor, so paging reaches the proof whatever the flags say.
    const deep = rig(checkout, shape, 10_000, 2);
    const deepSlot = await deep.driver.slot(checkout, "proof-pages-deep");
    await expect(deep.driver.run(deepSlot, "review"), shape).resolves.toBeUndefined();
    expect(deep.clock.now(), shape).toBeGreaterThanOrEqual(10_000);
    expect(deep.clock.now(), shape).toBeLessThan(11_000); // proven on the first poll after it arrived
    expect(deep.closed(), shape).toBeUndefined();
  }
}, 120_000);

// The reviewer the gates seat in an Orca pane: id ≠ "fake", so its key is fake-b:fake-b-1.
class PaneReviewer extends FakeAdapter {
  override id = "fake-b";
  override vendor = "fake-vb";
}

test("production runGates retires the reviewer after two omitted-flag launch failures while two explicit complete proof absences keep it eligible and both stay fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-proof-pages-"));
  const script = join(dir, "s.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const worker = new FakeAdapter(script);
  const reviewer = new PaneReviewer(script);
  const seatKey = "fake-b:fake-b-1";
  const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
  const channels: BillingChannel[] = [
    { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
    { adapter: "fake-b", vendor: "fake-vb", model: "fake-b-1", channel: "sub", tier: "frontier" },
  ];
  const task = validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: [{ oracle: "command", command: "true" }] }],
  }).tasks[0];

  // Three review rounds over one run-scoped tally, every seat launch through the production Orca create.
  const rounds = async (shape: Shape) => {
    const repo = realpathSync(makeRepo({ "a.txt": "x\n" })); // Orca compares canonical checkouts
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "a.txt"), "y\n");
    execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
    const { fake, driver } = rig(repo, shape);
    const reviewNoVerdicts = new Map<string, string[]>();
    const demotedReviewers = new Set<string>();
    const events: GateEvent[] = [];
    const round = async () => {
      const { results } = await runGates(task, {
        worktree: repo, baseRef: base, result: { ok: true, summary: "s", deviations: [], raw: "" }, author, commands: {},
        baseline: await captureBaseline(repo, {}), channels, adapters: [worker, reviewer],
        cfg: { ...DEFAULT_CONFIG, judge: { ...DEFAULT_CONFIG.judge, adapter: "fake", model: "fake-1" } },
        onGate: (e: GateEvent) => { events.push(e); },
        via: { driver, nameFor: (role: string, adapter: string) => `T1-${role}-${adapter}`, labelFor: (role: string) => role.toUpperCase() },
        reviewNoVerdicts, demotedReviewers,
      });
      return results.find((r) => r.gate === "review")!;
    };
    const two = [await round(), await round()];
    const creates = fake.countOf("create");
    const third = await round();
    const demotions = events.filter((e) => e.phase === "note" && e.name === "review-pool-demotion");
    return { two, creates, thirdCreates: fake.countOf("create") - creates, third, reviewNoVerdicts, demotedReviewers, demotions };
  };

  const absences = await rounds("explicit");
  for (const shape of ["no flags", "no limited", "no truncated"] as const) {
    const unread = await rounds(shape);
    // Both pairs: the seat was created and refused each round — a no-verdict infra row, never a pass.
    for (const [name, p, launchCause] of [["explicit", absences, "checkout-proof-timeout"], [shape, unread, undefined]] as const) {
      expect(p.creates, name).toBe(2);
      for (const review of p.two) {
        expect(review.pass, name).toBe(false);
        expect(review.meta, name).toMatchObject({ cause: "seat-launch-failed", noVerdict: true, infra: true, classification: "infra", reviewer: seatKey });
        expect(review.meta?.launchCause, name).toBe(launchCause);
      }
      expect(p.third.pass, name).toBe(false);
    }
    // Omitted flags: two ordinary launch failures strike twice and retire the seat; the third round has no one.
    expect(unread.reviewNoVerdicts.get(seatKey), shape).toEqual(["seat-launch-failed", "seat-launch-failed"]);
    expect(unread.demotedReviewers.has(seatKey), shape).toBe(true);
    expect(unread.demotions.map((e) => e.phase === "note" && e.payload), shape)
      .toEqual([{ reviewer: seatKey, cause: "seat-launch-failed", seatAuthoredBytes: 0, causes: ["seat-launch-failed", "seat-launch-failed"] }]);
    expect(unread.thirdCreates, shape).toBe(0);
    expect(unread.third.meta?.noEligibleReviewer, shape).toBe(true);
  }
  // Explicit complete absences: the host was slow, not the seat — no strike, still eligible, reseated and refused again.
  expect(absences.reviewNoVerdicts.get(seatKey)).toBeUndefined();
  expect(absences.demotedReviewers.has(seatKey)).toBe(false);
  expect(absences.demotions).toEqual([]);
  expect(absences.thirdCreates).toBe(1);
  expect(absences.third.meta).toMatchObject({ cause: "seat-launch-failed", launchCause: "checkout-proof-timeout", noVerdict: true, infra: true, reviewer: seatKey });
}, 180_000);
