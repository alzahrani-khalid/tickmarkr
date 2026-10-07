// v2.6.8 T1: a review seat that could not LAUNCH is never retired for it. Through the production daemon:
// one bounded same-seat relaunch before any other pick (A A before B or park), no strike or demotion for any
// launch failure live or after resume, two REAL no-verdicts still retire a seat for the run, a retired-only
// recovery pool names the seat out for the run without dispatching it, and the seven-gate merge rule holds.
// OrcaDriver's create types a ceiling-cut proof frame as the timeout. Zero tokens: fake adapters, a delegating
// subprocess driver that observes every actual review launch, and an injected Orca clock.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { CHECKOUT_MARK, checkoutProofLine, OrcaDriver, OrcaUnavailableError } from "../../src/drivers/orca.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { normalizeGateOutcome } from "../../src/run/outcome.js";
import type { ShResult } from "../../src/run/git.js";
import { FakeOrca, pacedReadExec, steppedTime, withheldProofExec } from "../helpers/fake-orca.js";
import { authedModels, COMMIT, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

const PANE = "visibility:\n  llm: pane\n  keepPanes: run\n";
const reviewCfg = (seats: string[]) => `${PANE}review: { required: true, prefer: [${seats.join(", ")}], timeoutMs: 5000 }\n`;
const work = (id: string, file = "work.txt") => ({ shell: `echo ${id} > ${file} && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
const rowsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
const of = (rows: JournalEvent[], event: string) => rows.filter((row) => row.taskId === "T1" && row.event === event);
const reviewRows = (rows: JournalEvent[]) => of(rows, "gate-result").filter((row) => row.data.gate === "review");
const A = "seat-a:seat-a", B = "seat-b:seat-b";
/** Every retired-only park persists the outcome the park acts on: the review gate-result published after each
 * cannot-seat row is an infrastructure no-verdict naming the retired seat — no `pass` for a round budget,
 * report or failure counter to read as a failed review, and never the gate-fail noEligibleReviewer shape. */
const parkedReviewsAreInfra = (rows: JournalEvent[], taskId = "T1") => {
  const mine = rows.filter((row) => row.taskId === taskId);
  const at = mine.flatMap((row, i) => row.event === "review-infra-retry" && row.data.cannotSeat === true ? [i] : []);
  expect(at.length, taskId).toBeGreaterThan(0);
  for (const i of at) {
    const row = mine.slice(i + 1).find((r) => r.event === "gate-result" && r.data.gate === "review");
    expect(row?.data, taskId).toMatchObject({ infra: true, skipped: true });
    expect(row!.data.pass, taskId).toBeUndefined();
    expect(row!.data.noEligibleReviewer, taskId).toBeUndefined();
    expect(normalizeGateOutcome(row!.data).kind, taskId).toBe("infra");
    expect(String(row!.data.details), taskId).toContain(`cannot seat ${A}`);
  }
};

type Reply = "approve" | "nonceless" | "malformed";
class Seat extends FakeAdapter {
  private turn = 0;
  /** `replies`: in turn, or by the reviewed task's id (approve when the task is not named). */
  constructor(path: string, public override id: string, private replies: Reply[] | Record<string, Reply> = ["approve"]) {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return "true";
    const nonce = extractPromptNonce(prompt);
    const task = /^## Task (\S+):/m.exec(prompt)?.[1] ?? "";
    const reply = Array.isArray(this.replies) ? this.replies[Math.min(this.turn++, this.replies.length - 1)]! : this.replies[task] ?? "approve";
    const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
    const body = reply === "malformed" ? `{"nonce": "${nonce}", "approve": true, "findings": [] "resolved": []}`
      : JSON.stringify(reply === "nonceless" ? { approve: true, findings: [] } : { nonce, approve: true, resolved: carried, reraised: [], findings: [] });
    // the marker names the seat to the pane driver, which sees only the dispatch script
    return `: SEAT=${this.id}; printf '%s' ${shq(body)}`;
  }
}
class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return super.channels().slice(0, 1); }
}

/** A real SubprocessDriver observing every review-seat launch in order (`launches`, failed ones included).
 * `refuse(seat, n, task)` (n = that seat's launch ordinal from 1) returns — or resolves to — the launch error, or
 * undefined to launch. `holdJudge` keeps the judge's launch pending until it resolves; `holdSlot` holds each
 * pane's creation until it resolves. `seated` names each review launch's task too. */
function launchDriver(refuse: (seat: string, n: number, task: string) => Error | undefined | Promise<Error | undefined>, holdJudge?: () => Promise<void>,
  holdSlot?: (name: string) => Promise<void>) {
  const inner = new SubprocessDriver();
  const launches: string[] = [];
  const seated: string[] = [];
  const driver = {
    id: "subprocess", interactive: false,
    status: inner.status.bind(inner),
    async slot(cwd: string, name: string) {
      await holdSlot?.(name);
      return inner.slot(cwd, name);
    },
    async run(slot: Slot, command: string) {
      const script = /([^'"\s]*dispatch\.sh)/.exec(command)?.[1];
      const seat = script ? /: SEAT=(seat-[a-z]);/.exec(readFileSync(script, "utf8"))?.[1] : undefined;
      if (seat) {
        launches.push(seat);
        const task = /^tickmarkr:review:([^:]+):/.exec(slot.name)?.[1] ?? "";
        seated.push(`${seat}/${task}`);
        const error = await refuse(seat, launches.filter((s) => s === seat).length, task);
        if (error) throw error;
      } else if (slot.name.startsWith("tickmarkr:judge:")) await holdJudge?.();
      return inner.run(slot, command);
    },
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: (slot: Slot) => inner.close(slot),
    worktree: inner.worktree.bind(inner),
  };
  return { driver, launches, seated };
}
const refused = () => new Error("pane create refused");
const proofTimeout = () => Object.assign(new Error("checkout proof absent (names no checkout)"), { launchCause: "checkout-proof-timeout" });
const otherDetail = () => Object.assign(new Error("orca terminal create: runtime busy"), { launchCause: "runtime-busy" });

describe("review-seat launch never retires a seat (production, zero tokens)", { timeout: 240_000 }, () => {
  test("production runDaemon dispatches the closed launch retry table as A A before B or park versus skipping A or looping A", async () => {
    // A fails once, A's relaunch delivers: A,A on the same candidate, one same-seat review-infra-retry naming A, and A's verdict decides.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("a0")] } }, reviewCfg(["seat-a", "seat-b"]));
      const { driver, launches } = launchDriver((seat, n) => seat === "seat-a" && n === 1 ? refused() : undefined);
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a"), new Seat(scriptPath, "seat-b")], runId: "run-once", driver });
      expect(s.done).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a"]); // A,B — skipping A's relaunch — fails here
      const rows = rowsOf(repo, "run-once");
      const retries = of(rows, "review-infra-retry");
      expect(retries.map((row) => row.data)).toEqual([expect.objectContaining({ reviewer: A, cause: "seat-launch-failed", sameSeat: true })]);
      const candidate = of(rows, "gate-result").find((row) => row.data.gate === "test")?.data.commit;
      expect(retries[0]!.data.commit).toBe(candidate);
      expect(reviewRows(rows).at(-1)!.data).toMatchObject({ pass: true, reviewer: A });
      expect(of(rows, "review-pool-demotion")).toEqual([]);
    }
    // A fails twice, B eligible: A,A,B — A's entitlement is spent, never an A loop.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("b0")] } }, reviewCfg(["seat-a", "seat-b"]));
      const { driver, launches } = launchDriver((seat) => seat === "seat-a" ? refused() : undefined);
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a"), new Seat(scriptPath, "seat-b")], runId: "run-twice-b", driver });
      expect(s.done).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a", "seat-b"]);
      expect(reviewRows(rowsOf(repo, "run-twice-b")).at(-1)!.data).toMatchObject({ pass: true, reviewer: B });
    }
    // A fails twice, only A eligible: A,A then a named infrastructure park retaining the missing review proof.
    // Then recheck and resume on the same candidate replay the spent episode bound: one ordinary launch, no relaunch,
    // no strike — and once A can launch, its real verdict decides.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("c0")] } }, reviewCfg(["seat-a"]));
      let released = false;
      const { driver, launches } = launchDriver((seat) => seat === "seat-a" && !released ? refused() : undefined);
      const adapters = [new Author(scriptPath), new Seat(scriptPath, "seat-a")];
      const s = await runDaemon(repo, { adapters, runId: "run-only-a", driver });
      expect(s.human).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a"]); // a third launch fails here
      let rows = rowsOf(repo, "run-only-a");
      expect(of(rows, "task-human").at(-1)!.data.kind).toBe("infra");
      expect(rows.some((row) => row.event === "merge" || row.event === "task-done")).toBe(false);
      expect(reviewRows(rows).at(-1)!.data).toMatchObject({ noVerdict: true, infra: true, cause: "seat-launch-failed", reviewer: A });
      expect(reviewRows(rows).at(-1)!.data.pass).toBeUndefined();
      await approve(["run-only-a", "T1", "--recheck", "--by", "op"], repo);
      expect((await runDaemon(repo, { adapters, runId: "run-only-a", resume: true, driver })).human).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a", "seat-a"]);
      rows = rowsOf(repo, "run-only-a");
      expect(of(rows, "review-infra-retry").filter((row) => row.data.sameSeat === true)).toHaveLength(1);
      expect(of(rows, "review-pool-demotion")).toEqual([]);
      released = true;
      await approve(["run-only-a", "T1", "--recheck", "--by", "op"], repo);
      expect((await runDaemon(repo, { adapters, runId: "run-only-a", resume: true, driver })).done).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a", "seat-a", "seat-a"]);
      expect(reviewRows(rowsOf(repo, "run-only-a")).at(-1)!.data).toMatchObject({ pass: true, reviewer: A });
    }
    // Zero launch failures: ordinary dispatch, no retry row.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("d0")] } }, reviewCfg(["seat-a", "seat-b"]));
      const { driver, launches } = launchDriver(() => undefined);
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a"), new Seat(scriptPath, "seat-b")], runId: "run-clean", driver });
      expect(s.done).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a"]);
      expect(of(rowsOf(repo, "run-clean"), "review-infra-retry")).toEqual([]);
    }
    // A launch failure then malformed deliveries: the relaunch never grants a second malformed allowance —
    // one relaunch plus the one fresh-nonce re-emission, then the park.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("e0")] } }, reviewCfg(["seat-a"]));
      const { driver, launches } = launchDriver((seat, n) => seat === "seat-a" && n === 1 ? refused() : undefined);
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a", ["malformed"])], runId: "run-malformed", driver });
      expect(s.human).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a", "seat-a"]);
      const rows = rowsOf(repo, "run-malformed");
      expect(of(rows, "review-reemission").map((row) => row.data)).toEqual([{ reviewer: A, cause: "malformed-verdict", delivered: false }]);
      expect(of(rows, "review-infra-retry")).toHaveLength(1);
    }
    // A malformed verdict whose fresh-nonce re-emission fails to launch: A's one relaunch delivers, which publishes
    // the re-emission's delivery — A is a delivery flake, not a bad reviewer — so after the judge rejects, the
    // repaired candidate seats A again and merges, never a noEligibleReviewer park.
    {
      const fail = { pass: false, criteria: [{ criterion: "c1", met: false, reason: "work.txt lacks the behavior" }] };
      const pass = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] };
      const { repo, scriptPath } = setupRepo([T("T1")], {
        judge: [fail, pass], consult: { action: "retry", notes: "fix it" }, tasks: { T1: [work("m0"), work("m1", "fix.txt")] },
      }, reviewCfg(["seat-a"]) + "gates: { test: \"true\" }\n");
      let relaunched!: () => void;
      const recovered = new Promise<void>((resolve) => { relaunched = resolve; });
      let held = false;
      const { driver, launches } = launchDriver((seat, n) => {
        if (seat === "seat-a" && n === 3) relaunched();
        return seat === "seat-a" && n === 2 ? refused() : undefined;
      }, async () => { if (!held) { held = true; await recovered; } });
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a", ["malformed", "approve"])], runId: "run-reemit-launch", driver });
      expect(s.done).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a", "seat-a", "seat-a"]);
      const rows = rowsOf(repo, "run-reemit-launch");
      expect(of(rows, "review-reemission").map((row) => row.data)).toEqual([{ reviewer: A, cause: "malformed-verdict", delivered: false },
        { reviewer: A, cause: "malformed-verdict", delivered: true, launchRetry: true }]);
      expect(of(rows, "task-dispatch")).toHaveLength(2);
      expect(reviewRows(rows).some((row) => row.data.noEligibleReviewer === true)).toBe(false);
      expect(reviewRows(rows).at(-1)!.data).toMatchObject({ pass: true, reviewer: A });
    }
  });

  test("production OrcaDriver create types a ceiling-cut frame checkout-proof-timeout at every wrap offset and refuses malformed anchor evidence versus a complete foreign placement refusal or an accepted decoy proof", async () => {
    const checkout = realpathSync(makeRepo({ "base.txt": "base\n" }));
    /** One production create over `checkout`: `readMs` (150) proof reads honoring their budgets over 2-row pages, the
     *  startup proof withheld; `seed` is what the terminal shows from create, `arrive` lands at `atMs`.
     *  `cutAt`: the cursor of the page read the ceiling cut — the rows read before it are [0, cutAt).
     *  `replace`: the first poll that starts at or after `atMs` finds the whole scrollback replaced by `rows`.
     *  `answer`: rewrites each read's terminal record (correctly bound) until that replacement lands; a result it
     *  returns replaces the read's whole answer (a failed read), and one it throws is the invocation's exception. */
    const launch = async (seed: (proof: string) => string[], arrive?: { atMs: number; rows: (proof: string) => string[] },
      replace?: { atMs: number; rows: (proof: string) => string[] },
      answer?: (cursor: string | undefined, term: Record<string, unknown>, clock: ReturnType<typeof steppedTime>) => ShResult | void,
      readMs = 150) => {
      const clock = steppedTime();
      const fake = new FakeOrca({ trackedWorktrees: [checkout], pageSize: 2 });
      const reads: { at: number; cut: boolean }[] = [];
      let proof = "", replaced = false;
      const paced = pacedReadExec(withheldProofExec(fake, clock, { seed: (p) => { proof = p; return seed(p); }, atMs: arrive?.atMs, arrive: arrive?.rows }), clock,
        { readMs, honor: true, onRead: (r) => reads.push(r) });
      let cutAt: number | undefined;
      const exec: typeof paced = async (args, cwd, timeoutMs) => {
        if (replace && !replaced && args[1] === "read" && !args.includes("--cursor") && clock.now() >= replace.atMs) {
          replaced = true;
          fake.last()!.lines.splice(0, Infinity, ...replace.rows(proof));
        }
        let r = await paced(args, cwd, timeoutMs);
        if (answer && !replaced && args[1] === "read" && r.code === 0) {
          const env = JSON.parse(r.stdout) as { result: { terminal: Record<string, unknown> } };
          r = answer(args.includes("--cursor") ? args[args.indexOf("--cursor") + 1] : undefined, env.result.terminal, clock) ?? { ...r, stdout: JSON.stringify(env) };
        }
        if (args[1] === "read" && r.timedOut === true && args.includes("--cursor")) cutAt = Number(args[args.indexOf("--cursor") + 1]);
        return r;
      };
      const driver = new OrcaDriver({ exec, time: clock, launchingHandle: "term_launch" });
      const slot = await driver.slot(checkout, "review-launch-proof");
      const error = await driver.run(slot, "review").then(() => undefined, (e: unknown) => e);
      return { error, clock, reads, fake, cutAt };
    };
    const banner = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `banner ${i + from}`);
    const wrapped = (proof: string, at = 24) => [proof.slice(0, at), proof.slice(at)];
    const foreign = checkoutProofLine("/tmp/another-checkout");
    // The terminal wraps the own frame anywhere: `split` cuts it into rows at the given offsets.
    const split = (proof: string, at: number[]) => [0, ...at].map((from, i) => proof.slice(from, at[i] ?? proof.length));
    const width = checkoutProofLine(checkout).length;
    const offsets = Array.from({ length: width - 1 }, (_, i) => i + 1);
    const layouts = [...offsets.map((a) => [a]), ...offsets.flatMap((a) => offsets.filter((b) => b > a).map((b) => [a, b]))];
    // The own frame lands late behind `lead` banner rows and two trailing rows. Paging timing never depends on
    // what the rows say (no read before the cut sees a whole frame), so one probe per row count finds the lead
    // whose last poll reads exactly `read` of the frame's rows and the 20000 ms ceiling cuts the read of the rest.
    const late = (lead: number, at: number[]) => launch(() => banner(lead), { atMs: 19_000, rows: (proof) => [...split(proof, at), ...banner(2, 90)] });
    const leadFor = async (rows: number, read: number) => {
      for (let lead = 1; lead <= 30; lead++) if ((await late(lead, offsets.slice(0, rows - 1))).cutAt === lead + read) return lead;
      throw new Error(`no lead cuts a ${rows}-row frame after ${read} read rows`);
    };
    // A one-row read of a two-wrap frame reads exactly what a one-row read of a one-wrap frame does, so the
    // sweep reads one row of every one-wrap layout and two rows of every two-wrap one: every proper prefix of
    // the frame, in every way the terminal can wrap it into the rows read.
    const leads = [0, await leadFor(2, 1), await leadFor(3, 2)];
    // With NO trailing rows the frame's own last rows are the 2-row anchor (`T` | ` 40:…;` included), overlapping
    // or abutting the pages. On screen from create, 1500 ms reads let the one poll read the anchor and 12 pages —
    // rows [0, 24) — before the ceiling cuts the 13th, so `24 - read` banners leave `read` of the frame's rows read.
    const cutWhole = (read: number, at: number[]) => launch((proof) => [...banner(24 - read), ...split(proof, at)], undefined, undefined, undefined, 1_500);
    // EXHAUSTIVE wrap sweep, each layout cut before its last row. An incomplete frame the CEILING cut is unread —
    // the typed timeout — wherever the terminal wrapped it: inside its `TICKMARKR` head, at its separator, in its
    // length or hex, across one row boundary or two, behind trailing rows or with the anchor inside the frame.
    const missed: string[] = [];
    const typedCut = (r: Awaited<ReturnType<typeof launch>>, cutAt: number) => {
      const error = r.error as OrcaUnavailableError;
      return r.cutAt === cutAt && error instanceof OrcaUnavailableError && error.launchCause === "checkout-proof-timeout"
        && /does not prove checkout \S+ within 20000 ms .*the ceiling cut off paging, .*proof frame the ceiling cut off before it was read whole/.test(error.message)
        && r.fake.countOf("close") === 1;
    };
    const miss = (what: string, r: Awaited<ReturnType<typeof launch>>) =>
      missed.push(`${what}: cutAt ${r.cutAt}, ${(r.error as OrcaUnavailableError)?.launchCause ?? "no cause"}: ${(r.error as Error)?.message}`);
    for (const at of layouts) {
      const read = at.length, lead = leads[read]!;
      const r = await late(lead, at);
      if (!typedCut(r, lead + read)) miss(`wrap ${at.join(",")} cut after ${read} row(s)`, r);
      for (let anchored = 1; anchored <= at.length; anchored++) {
        const whole = await cutWhole(anchored, at);
        if (!typedCut(whole, 24)) miss(`wrap ${at.join(",")} no trailing rows, cut after ${anchored} row(s)`, whole);
      }
    }
    expect(missed).toEqual([]);
    // The same sweep read whole inside the budget: every wrap layout of the complete matching frame seats, on
    // either page alignment — arriving late behind trailing rows, or on screen from create behind them or with
    // none, the anchor then beginning inside the frame the pages read whole (`T` | ` 40:…;`) — never a
    // malformed refusal because of where the terminal wrapped it.
    const refused: string[] = [];
    for (const at of layouts) {
      for (const lead of [13, 14]) {
        const rows = (trail: number) => (proof: string) => [...split(proof, at), ...banner(trail, 90)];
        for (const [how, seated] of [
          ["late", await launch(() => banner(lead), { atMs: 1_000, rows: rows(2) })],
          ["trail 2", await launch((proof) => [...banner(lead), ...rows(2)(proof)])],
          ["trail 0", await launch((proof) => [...banner(lead), ...rows(0)(proof)])],
        ] as const) {
          if (seated.error !== undefined || seated.clock.now() >= 20_000) refused.push(`wrap ${at.join(",")} lead ${lead} ${how}: ${String(seated.error)}`);
        }
      }
    }
    expect(refused).toEqual([]);
    // A complete foreign frame read whole stays a placement refusal without the timeout cause — even beside a cut frame.
    const foreignWhole = await launch(() => [...banner(3), foreign]);
    expect((foreignWhole.error as OrcaUnavailableError).message).toMatch(/names \/tmp\/another-checkout/);
    expect((foreignWhole.error as OrcaUnavailableError).launchCause).toBeUndefined();
    // The matching frame early in the first cursor page, where paging stops, beside contradicting evidence in the
    // anchor's tail the pages never reached, or in that same first page: a complete foreign frame (with and without
    // an incomplete frame beside it), an unparseable header, a terminated frame of the wrong length, an unterminated
    // frame, or a row that is only a mark prefix too short for MARK_TRACE (`T` … `TICKMARKR_`). Proof is classified
    // over everything read: each refuses at the ceiling without the timeout cause, while the same layout with a
    // harmless row in that place seats at once.
    const marks = ["TICKMARKR_CHECKOUT x:ff;", "TICKMARKR_CHECKOUT 1:0000;", "TICKMARKR_CHECKOUT 1:ff",
      ...Array.from({ length: 10 }, (_, i) => CHECKOUT_MARK.slice(0, i + 1))];
    const contradictions: [string, (proof: string) => string[], RegExp][] = [
      ...[[foreign], [foreign.slice(0, 24), foreign]].map((extra) =>
        [`anchor ${extra.length}`, (proof: string) => [proof, ...banner(2), ...extra], /names .*\/tmp\/another-checkout/] as [string, (proof: string) => string[], RegExp]),
      ...marks.flatMap((mark) => [
        [`anchor ${mark}`, (proof: string) => [proof, ...banner(2), mark], /malformed proof marker|incomplete proof frame/],
        [`page ${mark}`, (proof: string) => [proof, mark, ...banner(3)], /malformed proof marker|incomplete proof frame/],
      ] as [string, (proof: string) => string[], RegExp][]),
    ];
    for (const [name, rows, why] of contradictions) {
      const contradicted = await launch(rows);
      expect(contradicted.error, name).toBeInstanceOf(OrcaUnavailableError);
      expect((contradicted.error as OrcaUnavailableError).message, name).toMatch(/within 20000 ms /);
      expect((contradicted.error as OrcaUnavailableError).message, name).toMatch(why);
      expect((contradicted.error as OrcaUnavailableError).launchCause, name).toBeUndefined();
      expect(contradicted.clock.now(), name).toBeGreaterThanOrEqual(20_000);
      expect(contradicted.fake.countOf("close"), name).toBe(1);
      const control = await launch((proof) => rows(proof).map((row) => row === proof || row.startsWith("banner") ? row : "banner 99"));
      expect(control.error, `${name} control`).toBeUndefined();
      expect(control.clock.now(), `${name} control`).toBeLessThan(20_000);
    }
    // Evidence is kept across polls: the first poll reads a complete foreign frame, a malformed or unterminated mark or
    // a mark prefix, then the scrollback is REPLACED by the matching proof alone. That later read never turns the
    // window into proof — refused at the ceiling, closed, no timeout cause — while the same replacement over a
    // harmless first read seats as soon as it is read.
    for (const first of [foreign, ...marks]) {
      const shifted = await launch(() => [...banner(2), first], undefined, { atMs: 500, rows: (proof) => [proof, ...banner(2)] });
      expect(shifted.error, first).toBeInstanceOf(OrcaUnavailableError);
      expect((shifted.error as OrcaUnavailableError).message, first).toMatch(/names .*\/tmp\/another-checkout|malformed proof marker|incomplete proof frame/);
      expect((shifted.error as OrcaUnavailableError).launchCause, first).toBeUndefined();
      expect(shifted.clock.now(), first).toBeGreaterThanOrEqual(20_000);
      expect(shifted.fake.countOf("close"), first).toBe(1);
    }
    const harmless = await launch(() => banner(3), undefined, { atMs: 500, rows: (proof) => [proof, ...banner(2)] });
    expect(harmless.error).toBeUndefined();
    expect(harmless.clock.now()).toBeGreaterThanOrEqual(500);
    expect(harmless.clock.now()).toBeLessThan(20_000);
    // A correctly bound read whose cursor metadata is malformed — oldestCursor or nextCursor 123, "", {} or [] — on
    // the anchor or the first cursor page still SHOWED its well-formed rows: a foreign frame, malformed or
    // unterminated mark or mark prefix there is evidence the matching proof that replaces the scrollback later
    // never outweighs (refused at the ceiling, closed, no timeout cause), while a harmless row there seats.
    const replaced = { atMs: 500, rows: (proof: string) => [proof, ...banner(2)] };
    const malformedCursors: string[] = [];
    for (const key of ["oldestCursor", "nextCursor"]) {
      for (const value of [123, "", {}, []]) {
        for (const where of ["anchor", "page"] as const) {
          const answer = (cursor: string | undefined, term: Record<string, unknown>) => {
            if (where === "anchor" ? cursor === undefined : cursor === "0") term[key] = value;
          };
          const rows = (row: string) => where === "anchor" ? [...banner(2), row] : [row, ...banner(3)];
          const name = (row: string) => `${where} ${key}=${JSON.stringify(value)} ${row}`;
          for (const row of [foreign, ...marks]) {
            const r = await launch(() => rows(row), undefined, replaced, answer);
            const message = r.error instanceof OrcaUnavailableError ? r.error.message : "";
            if (!/within 20000 ms .*(names .*\/tmp\/another-checkout|malformed proof marker|incomplete proof frame).*is not a cursor/.test(message)
              || (r.error as OrcaUnavailableError).launchCause !== undefined || r.clock.now() < 20_000 || r.fake.countOf("close") !== 1) {
              malformedCursors.push(`${name(row)}: ${String(r.error)} at ${r.clock.now()} ms`);
            }
          }
          const control = await launch(() => rows("banner 99"), undefined, replaced, answer);
          if (control.error !== undefined || control.clock.now() >= 20_000) malformedCursors.push(`${name("banner 99")} control: ${String(control.error)}`);
        }
      }
    }
    expect(malformedCursors).toEqual([]);
    // ONE rule over the whole read: every row a bound read returns is evidence, once, at its position, before any
    // row-type check can discard it. A non-string row (123, null, {}, [] or false) before or after a foreign frame,
    // a malformed or unterminated mark or a mark prefix, on the anchor or the first cursor page, still refuses — the
    // decoy matching proof that replaces the scrollback later never seats that window — while the same non-string
    // row beside a harmless row is an unread page only, and the replacement then seats.
    const mixedRows: string[] = [];
    for (const mixed of [123, null, {}, [], false]) {
      for (const where of ["anchor", "page"] as const) {
        for (const order of ["before", "after"] as const) {
          const answer = (row: string) => (cursor: string | undefined, term: Record<string, unknown>) => {
            if (where === "anchor" ? cursor === undefined : cursor === "0") term.tail = order === "before" ? [mixed, row] : [row, mixed];
          };
          const rows = (row: string) => where === "anchor" ? [...banner(2), row] : [row, ...banner(3)];
          const name = (row: string) => `${where} ${order} ${JSON.stringify(mixed)} ${row}`;
          for (const row of [foreign, ...marks]) {
            const r = await launch(() => rows(row), undefined, replaced, answer(row));
            const message = r.error instanceof OrcaUnavailableError ? r.error.message : "";
            if (!/within 20000 ms .*(names .*\/tmp\/another-checkout|malformed proof marker|incomplete proof frame).*non-string line/.test(message)
              || (r.error as OrcaUnavailableError).launchCause !== undefined || r.clock.now() < 20_000 || r.fake.countOf("close") !== 1) {
              mixedRows.push(`${name(row)}: ${String(r.error)} at ${r.clock.now()} ms`);
            }
          }
          const control = await launch(() => rows("banner 99"), undefined, replaced, answer("banner 99"));
          if (control.error !== undefined || control.clock.now() >= 20_000) mixedRows.push(`${name("banner 99")} control: ${String(control.error)}`);
        }
      }
    }
    expect(mixedRows).toEqual([]);
    // Overlap between reads is ROW IDENTITY — the same cursor position re-read — never equal text. The own frame
    // wrapped `TICKMARKR_CHECKOU` | `T` | ` N:…;` at the end of the scrollback, behind every banner count, seats: the
    // 2-row anchor re-reads the frame's last rows at the positions the pages read. The same two rows repeated after
    // it as a SEPARATE partial marker tail are new rows at new positions — a partial frame, never erased as an
    // overlap — and refuse at the ceiling without the timeout cause.
    const identity: string[] = [];
    for (let lead = 0; lead <= 15; lead++) {
      const overlap = await launch((proof) => [...banner(lead), ...split(proof, [17, 18])]);
      if (overlap.error !== undefined || overlap.clock.now() >= 20_000) identity.push(`overlap lead ${lead}: ${String(overlap.error)}`);
      const separate = await launch((proof) => [...banner(lead), ...split(proof, [17, 18]), ...banner(2, 90), "T", proof.slice(18)]);
      const error = separate.error;
      if (!(error instanceof OrcaUnavailableError) || error.launchCause !== undefined || !/within 20000 ms .*malformed proof marker|incomplete proof frame/.test(error.message)
        || separate.clock.now() < 20_000 || separate.fake.countOf("close") !== 1) identity.push(`separate tail lead ${lead}: ${String(error)}`);
    }
    expect(identity).toEqual([]);
    const beside = await (async () => {
      for (let lead = 1; lead <= 24; lead++) {
        const r = await launch(() => [...banner(lead), foreign], { atMs: 19_000, rows: (proof) => [...wrapped(proof), ...banner(2, 90)] });
        if (/proof frame the ceiling cut|ceiling cut off paging/.test(r.error instanceof Error ? r.error.message : "")) return r;
      }
      return undefined;
    })();
    expect(beside).toBeDefined();
    expect((beside!.error as OrcaUnavailableError).launchCause).toBeUndefined();
    // A malformed marker read whole in the anchor — an unparseable header, or a terminated frame of the wrong
    // length — while a later page read hits the ceiling: no frame was left unread, so it stays a placement refusal.
    for (const malformed of ["TICKMARKR_CHECKOUT x:ff;", "TICKMARKR_CHECKOUT 1:0000;"]) {
      const whole = await (async () => {
        for (let lead = 1; lead <= 24; lead++) {
          const r = await launch(() => banner(lead), { atMs: 19_000, rows: () => [malformed, "banner 90"] });
          if (/the ceiling cut off paging/.test(r.error instanceof Error ? r.error.message : "")) return r;
        }
        return undefined;
      })();
      expect(whole, malformed).toBeDefined();
      expect((whole!.error as OrcaUnavailableError).message, malformed).toMatch(/malformed proof marker|incomplete proof frame/);
      expect((whole!.error as OrcaUnavailableError).launchCause, malformed).toBeUndefined();
    }
    // A frame the terminal printed incomplete, read whole inside the ceiling, is still placement evidence.
    const misprint = await launch((proof) => [...banner(3), proof.slice(0, 24)]);
    expect((misprint.error as OrcaUnavailableError).launchCause).toBeUndefined();
    // Positions, never bytes, join cursor pages: the own frame's prefix read at cursor 0 and its suffix read at
    // cursor 100 — positions 1…99 never read — is no proof (refused at the ceiling, closed, no timeout cause),
    // while the same two rows at contiguous positions 0 and 1 seat.
    const own = checkoutProofLine(checkout);
    for (const gap of [true, false]) {
      const second = gap ? 100 : 1;
      const rows: Record<string, [string[], number, boolean]> = {
        "0": [[own.slice(0, 24)], second, true], [second]: [[own.slice(24)], second + 1, true], [second + 1]: [["banner 1"], second + 2, false],
      };
      const bridged = await launch(() => [], undefined, undefined, (cursor, term) => {
        const [tail, next, limited] = cursor === undefined ? [["banner 1"], second + 2, false] as const : rows[cursor] ?? [[], second + 2, false];
        Object.assign(term, { tail: [...tail], oldestCursor: "0", nextCursor: String(next), latestCursor: String(second + 2), limited,
          truncated: cursor === undefined, returnedLineCount: tail.length });
      });
      if (gap) {
        expect(bridged.error, "gap").toBeInstanceOf(OrcaUnavailableError);
        expect((bridged.error as OrcaUnavailableError).message, "gap").toMatch(/within 20000 ms .*incomplete proof frame/);
        expect((bridged.error as OrcaUnavailableError).launchCause, "gap").toBeUndefined();
        expect(bridged.clock.now(), "gap").toBeGreaterThanOrEqual(20_000);
        expect(bridged.fake.countOf("close"), "gap").toBe(1);
      } else {
        expect(bridged.error, "contiguous").toBeUndefined();
        expect(bridged.clock.now(), "contiguous").toBeLessThan(20_000);
      }
    }
    // The anchor is a reading of the positions it names, read WHOLE and kept beside the pages' later reading of
    // them: an anchor at position 0 — or ending at position 23, where the pages then read the own frame's prefix —
    // that read a complete foreign frame, a malformed or an unterminated marker, while the ceiling cuts the own
    // frame at position 23, is placement evidence — refused without the timeout cause, never sliced away as the
    // pages' cut — while the same layout under a harmless anchor reading is the typed ceiling cut.
    for (const [at, first] of [0, 22].flatMap((at) => [foreign, "TICKMARKR_CHECKOUT x:ff;", "TICKMARKR_CHECKOUT 1:ff", "banner 99"].map((first) => [at, first] as const))) {
      const r = await launch((proof) => [...banner(23), ...wrapped(proof)], undefined, undefined, (cursor, term) => {
        if (cursor === undefined) Object.assign(term, { tail: at === 0 ? [first, "banner 1"] : ["banner 23", first], oldestCursor: "0", nextCursor: String(at + 2), latestCursor: String(at + 2) });
      }, 1_500);
      const error = r.error as OrcaUnavailableError;
      expect(r.cutAt, `${at} ${first}`).toBe(24);
      expect(error, first).toBeInstanceOf(OrcaUnavailableError);
      expect(r.fake.countOf("close"), first).toBe(1);
      if (first === "banner 99") expect(typedCut(r, 24), first).toBe(true);
      else {
        expect(error.message, first).toMatch(/names .*\/tmp\/another-checkout|malformed proof marker|incomplete proof frame/);
        expect(error.message, first).not.toMatch(/proof frame the ceiling cut off/);
        expect(error.launchCause, first).toBeUndefined();
      }
    }
    // A complete cursorless page holding an unterminated marker, returned WHOLE but landing past the ceiling, is
    // a late page, not one the ceiling cut: the misprint read whole stays a placement refusal without the timeout
    // cause, exactly as the same page read inside the budget.
    for (const lateBy of [20_001, 0]) {
      const r = await launch(() => banner(3), undefined, undefined, (cursor, term, clock) => {
        if (cursor !== undefined) return;
        Object.assign(term, { tail: ["banner 1", "banner 2", "TICKMARKR_CHECKOUT 1:ff"], limited: false, truncated: false, nextCursor: "3", latestCursor: "3" });
        delete term.oldestCursor;
        clock.advance(lateBy);
      });
      const error = r.error as OrcaUnavailableError;
      expect(error, `${lateBy}`).toBeInstanceOf(OrcaUnavailableError);
      expect(error.message, `${lateBy}`).toMatch(/within 20000 ms .*incomplete proof frame/);
      if (lateBy > 0) expect(error.message).toMatch(/read past the ceiling/);
      expect(error.message, `${lateBy}`).not.toMatch(/proof frame the ceiling cut off/);
      expect(error.launchCause, `${lateBy}`).toBeUndefined();
      expect(r.fake.countOf("close"), `${lateBy}`).toBe(1);
    }
    // The same rule at every arrival, over a scrollback of six rows whose read row 5 (the anchor, 4–5: paging never
    // starts), 1 (the first cursor page, 0–1) or 3 (a later one, 2–3; the anchor harmless at 4–5) holds a marker read
    // WHOLE — `T`, `TICKMARKR_`, an unterminated `1:ff` or a foreign frame's prefix — landing inside the budget, at
    // 19999, EXACTLY at the 20000 ms ceiling, or at 20001 ms. Lateness ends paging, it never cuts a read: a page that
    // lands at the ceiling spends the budget (the next read is never issued, nothing is interrupted) and one past it
    // is late, so every marker stays a placement refusal without the timeout cause. The one typed cut is the 19999
    // first page ending in a prefix of the OWN frame (`T`, `TICKMARKR_`): its next read is issued and the ceiling
    // INTERRUPTS it, so the own frame may continue unread. A prefix no continuation can make the own frame (`1:ff`, a
    // foreign length) refuses even then, and so does any marker whose following rows the anchor already read.
    const foreignPrefix = foreign.slice(0, 24);
    const lateTable: string[] = [];
    for (const mark of ["T", "TICKMARKR_", "TICKMARKR_CHECKOUT 1:ff", foreignPrefix]) {
      for (const [where, lateOn, markAt] of [["anchor", undefined, 5], ["page 0", "0", 1], ["page 2", "2", 3]] as const) {
        const lines = Array.from({ length: 6 }, (_, i) => i === markAt ? mark : `banner ${i + 1}`);
        for (const arriveAt of [undefined, 19_999, 20_000, 20_001]) {
          const name = `${JSON.stringify(mark)} ${where} arriving at ${arriveAt ?? "in budget"}`;
          const r = await launch(() => [], undefined, undefined, (cursor, term, clock) => {
            const from = cursor === undefined ? 4 : Number(cursor), tail = lines.slice(from, from + 2);
            Object.assign(term, { tail, oldestCursor: "0", nextCursor: String(from + 2), latestCursor: "6",
              limited: cursor !== undefined && from + 2 < 6, truncated: cursor === undefined, returnedLineCount: tail.length });
            if (cursor === lateOn && arriveAt !== undefined) clock.advance(arriveAt - clock.now());
          });
          const error = r.error as OrcaUnavailableError;
          const message = error instanceof OrcaUnavailableError ? error.message : String(r.error);
          const typed = where === "page 0" && arriveAt === 19_999 && (mark === "T" || mark === "TICKMARKR_");
          const ok = error instanceof OrcaUnavailableError && r.fake.countOf("close") === 1 && (typed
            ? typedCut(r, 2)
            // at 19999 the next read (cursor 0 after the anchor, else the page's next) is issued and interrupted; at
            // the ceiling or past it none is issued at all
            : error.launchCause === undefined && (arriveAt === undefined || r.cutAt === (arriveAt === 19_999 ? (lateOn === undefined ? 0 : Number(lateOn) + 2) : undefined))
              && /within 20000 ms .*(malformed proof marker|incomplete proof frame)/.test(message)
              && !/proof frame the ceiling cut off/.test(message)
              && (arriveAt !== 20_000 || /a page landed at the ceiling with scrollback unread, /.test(message))
              && (arriveAt !== 20_001 || /read past the ceiling, /.test(message)));
          if (!ok) lateTable.push(`${name}: cutAt ${r.cutAt}, ${error?.launchCause ?? "no cause"}: ${message}`);
        }
      }
    }
    expect(lateTable).toEqual([]);
    // Only POSITIVE evidence that the ceiling interrupted an issued read — the CLI killed at the budget it was handed
    // (timedOut) — is the cut; elapsed time alone never is. Over the same six rows, the first cursor page reading
    // [banner, `T`] beside a harmless anchor, a read of the anchor, the first cursor page or the next one (cursor 2)
    // that FAILS for another reason — a nonzero exit, unparseable output, an invocation exception — at 19999, exactly
    // at the 20000 ms ceiling or at 20001 ms keeps its own failure and the evidence read before it, with no timeout
    // cause. The control: the cursor-2 read killed at its budget (timedOut) at or past the ceiling is the typed cut.
    const failures: [string, () => ShResult, RegExp][] = [
      ["nonzero exit", () => ({ code: 1, stdout: "", stderr: "orca: terminal read failed", timedOut: false }), /orca CLI exited 1[^ ]/],
      ["unparseable output", () => ({ code: 0, stdout: "not json {", stderr: "", timedOut: false }), /unparseable response/],
      ["invocation exception", () => { throw new Error("spawn EACCES"); }, /could not be invoked \(spawn EACCES\)/],
    ];
    const failedTable: string[] = [];
    const sixRows = ["banner 1", "T", "banner 3", "banner 4", "banner 5", "banner 6"];
    const failingRead = (failOn: string | undefined, arriveAt: number, fail: () => ShResult) =>
      launch(() => [], undefined, undefined, (cursor, term, clock) => {
        const from = cursor === undefined ? 4 : Number(cursor), tail = sixRows.slice(from, from + 2);
        Object.assign(term, { tail, oldestCursor: "0", nextCursor: String(from + 2), latestCursor: "6",
          limited: cursor !== undefined && from + 2 < 6, truncated: cursor === undefined, returnedLineCount: tail.length });
        if (cursor !== failOn) return;
        clock.advance(arriveAt - clock.now());
        return fail();
      });
    for (const [what, fail, why] of failures) {
      for (const [where, failOn] of [["anchor", undefined], ["page 0", "0"], ["page 2", "2"]] as const) {
        for (const arriveAt of [19_999, 20_000, 20_001]) {
          const name = `${what} on the ${where} read at ${arriveAt}`;
          const r = await failingRead(failOn, arriveAt, fail);
          const error = r.error as OrcaUnavailableError;
          const message = error instanceof OrcaUnavailableError ? error.message : String(r.error);
          const ok = error instanceof OrcaUnavailableError && error.launchCause === undefined && r.cutAt === undefined
            && r.fake.countOf("close") === 1 && /within 20000 ms /.test(message) && why.test(message)
            && !/the ceiling cut off|proof frame the ceiling cut off/.test(message)
            // what was read before the failure stays evidence: the first page's `T` is a malformed marker
            && (where !== "page 2" || /malformed proof marker.*then a read failed/.test(message));
          if (!ok) failedTable.push(`${name}: cutAt ${r.cutAt}, ${error?.launchCause ?? "no cause"}: ${message}`);
        }
      }
    }
    for (const arriveAt of [20_000, 20_001]) {
      const killed = await failingRead("2", arriveAt, () => ({ code: 137, signalExit: true, stdout: "", stderr: "", timedOut: true }));
      if (!typedCut(killed, 2)) failedTable.push(`killed at ${arriveAt}: cutAt ${killed.cutAt}, ${String(killed.error)}`);
    }
    expect(failedTable).toEqual([]);
  });

  test("production runDaemon keeps A eligible after three launch failures versus retirement after two real no-verdicts across resume", async () => {
    // Launch failures of every kind — no launchCause, checkout-proof-timeout, other detail — three of them
    // (live A,A, then one resumed launch): no strike, no demotion, and a later round seats A again.
    for (const [name, error] of [["absent", refused], ["timeout", proofTimeout], ["other", otherDetail]] as const) {
      const runId = `run-keep-${name}`;
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work(`k-${name}`)] } }, reviewCfg(["seat-a"]));
      let released = false;
      const { driver, launches } = launchDriver((seat) => seat === "seat-a" && !released ? error() : undefined);
      const adapters = [new Author(scriptPath), new Seat(scriptPath, "seat-a")];
      expect((await runDaemon(repo, { adapters, runId, driver })).human, name).toEqual(["T1"]);
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human, name).toEqual(["T1"]);
      expect(launches, name).toEqual(["seat-a", "seat-a", "seat-a"]);
      let rows = rowsOf(repo, runId);
      expect(of(rows, "review-no-verdict").map((row) => row.data.cause), name).toEqual(["seat-launch-failed", "seat-launch-failed", "seat-launch-failed"]);
      expect(rows.filter((row) => row.event === "review-pool-demotion"), name).toEqual([]);
      released = true;
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).done, name).toEqual(["T1"]);
      expect(launches, name).toHaveLength(4); // the fourth round seats A
      rows = rowsOf(repo, runId);
      expect(reviewRows(rows).at(-1)!.data, name).toMatchObject({ pass: true, reviewer: A });
    }
    // Two REAL no-verdicts (a verdict with no nonce), one live and one after resume, retire A for the run:
    // a later recheck never seats it again, and no review passes.
    {
      const runId = "run-retire";
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("n0")] } }, reviewCfg(["seat-a"]));
      const seat = new Seat(scriptPath, "seat-a", ["nonceless", "nonceless", "approve"]);
      const { driver, launches } = launchDriver(() => undefined);
      const adapters = [new Author(scriptPath), seat];
      expect((await runDaemon(repo, { adapters, runId, driver })).human).toEqual(["T1"]);
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a"]);
      let rows = rowsOf(repo, runId);
      expect(of(rows, "review-no-verdict").every((row) => row.data.cause !== "seat-launch-failed")).toBe(true);
      expect(rows.filter((row) => row.event === "review-pool-demotion").map((row) => row.data.reviewer)).toEqual([A]);
      const cannotSeat = (r: JournalEvent[]) => of(r, "review-infra-retry").filter((row) => row.data.cause === "retired");
      expect(cannotSeat(rows).map((row) => row.data)).toEqual([expect.objectContaining({ reviewer: A, cannotSeat: true })]);
      // The third recheck finds no eligible reviewer at all: the retired-only park is replayed — cannot-seat
      // recorded again, an infrastructure park naming A out for the run, never a gate-fail.
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      const third = await runDaemon(repo, { adapters, runId, resume: true, driver });
      expect(third.done).toEqual([]);
      expect(third.human).toEqual(["T1"]);
      expect(launches).toEqual(["seat-a", "seat-a"]); // retired: never launched again
      rows = rowsOf(repo, runId);
      expect(reviewRows(rows).some((row) => row.data.pass === true)).toBe(false);
      // the round found no eligible reviewer; that row is published as the park's infrastructure no-verdict
      parkedReviewsAreInfra(rows);
      expect(cannotSeat(rows).map((row) => row.data)).toEqual([expect.objectContaining({ reviewer: A, cannotSeat: true }),
        expect.objectContaining({ reviewer: A, cannotSeat: true, causes: [expect.any(String), expect.any(String)] })]);
      const park = of(rows, "task-human").at(-1)!;
      expect(park.data.kind).toBe("infra");
      expect(String(park.data.reason)).toContain(`cannot seat ${A}`);
      expect(String(park.data.reason)).toContain("out for the run");
    }
    // An older engine's journal: two launch failures and the launch-caused review-pool-demotion it wrote for
    // them. A resume never replays that demotion — A is launched again and its verdict decides. A real one-strike
    // no-verdict demotion in the same position is replayed soft — A only ranks last, so the only seat is still
    // seated — never as the hard exclusion only two real no-verdicts (above) earn.
    for (const [name, demotion] of [
      ["launch", { reviewer: A, cause: "seat-launch-failed", seatAuthoredBytes: 0, causes: ["seat-launch-failed", "seat-launch-failed"] }],
      ["real", { reviewer: A, cause: "silent", seatAuthoredBytes: 0 }],
    ] as const) {
      const runId = `run-legacy-${name}`;
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work(`g-${name}`)] } }, reviewCfg(["seat-a"]));
      let released = false;
      const { driver, launches } = launchDriver((seat) => seat === "seat-a" && !released ? refused() : undefined);
      const adapters = [new Author(scriptPath), new Seat(scriptPath, "seat-a")];
      expect((await runDaemon(repo, { adapters, runId, driver })).human, name).toEqual(["T1"]);
      Journal.open(repo, runId).append("review-pool-demotion", "T1", { ...demotion });
      released = true;
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      const resumed = await runDaemon(repo, { adapters, runId, resume: true, driver });
      expect(resumed.done, name).toEqual(["T1"]);
      expect(launches, name).toEqual(["seat-a", "seat-a", "seat-a"]);
      expect(reviewRows(rowsOf(repo, runId)).at(-1)!.data, name).toMatchObject({ pass: true, reviewer: A });
      expect(of(rowsOf(repo, runId), "review-infra-retry").filter((row) => row.data.cause === "retired"), name).toEqual([]);
    }
  });

  test("production runDaemon and runGates never dispatch a seat another task retired during an awaited pick and record cannot-seat retired A as one infrastructure outcome versus dispatching eligible B", async () => {
    // A answers real no-verdicts; B cannot launch. Live: A strikes once, B is relaunched once and refused.
    // Resumed: A's second strike retires it, B's spent relaunch is not re-granted, and the recovery pool holds
    // only retired A — recorded as cannot-seat, no dispatch bought, the park naming A out for the run.
    const runId = "run-retired-pool";
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("p0")] } }, reviewCfg(["seat-a", "seat-b"]));
    let releaseB = false;
    const { driver, launches } = launchDriver((seat) => seat === "seat-b" && !releaseB ? refused() : undefined);
    const adapters = [new Author(scriptPath), new Seat(scriptPath, "seat-a", ["nonceless"]), new Seat(scriptPath, "seat-b")];
    expect((await runDaemon(repo, { adapters, runId, driver })).human).toEqual(["T1"]);
    expect(launches).toEqual(["seat-a", "seat-b", "seat-b"]);
    expect(of(rowsOf(repo, runId), "review-infra-retry").filter((row) => row.data.cause === "retired")).toEqual([]);
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human).toEqual(["T1"]);
    expect(launches).toEqual(["seat-a", "seat-b", "seat-b", "seat-a", "seat-b"]);
    let rows = rowsOf(repo, runId);
    const cannot = of(rows, "review-infra-retry").filter((row) => row.data.cause === "retired");
    expect(cannot.map((row) => row.data)).toEqual([expect.objectContaining({ reviewer: A, cannotSeat: true, causes: [expect.any(String), expect.any(String)] })]);
    const park = of(rows, "task-human").at(-1)!;
    expect(park.data.kind).toBe("infra");
    expect(String(park.data.reason)).toContain(`cannot seat ${A}`);
    expect(String(park.data.reason)).toContain("out for the run");
    // A retired-only pool again: still cannot-seat, and A is never dispatched by a soft-ranked pick.
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human).toEqual(["T1"]);
    expect(launches.filter((seat) => seat === "seat-a")).toHaveLength(2);
    rows = rowsOf(repo, runId);
    expect(String(of(rows, "task-human").at(-1)!.data.reason)).toContain("out for the run");
    parkedReviewsAreInfra(rows);
    // Eligible B beside retired A: B is dispatched and decides; prefer (A first) and history cannot resurrect A.
    releaseB = true;
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).done).toEqual(["T1"]);
    expect(launches.filter((seat) => seat === "seat-a")).toHaveLength(2);
    expect(launches.at(-1)).toBe("seat-b");
    expect(reviewRows(rowsOf(repo, runId)).at(-1)!.data).toMatchObject({ pass: true, reviewer: B });

    // Another task retires the seat T1's round is waiting on. T0 gives A its first real no-verdict (B approves T0);
    // then T1 and T2 review concurrently and T2 supplies A's second while T1's dispatch is pending. The tally is
    // read live before every retry pick: retired A is never relaunched, re-asked or re-routed to for T1.
    const poll = async (what: string, ok: () => boolean) => {
      for (let i = 0; i < 3000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!ok()) throw new Error(`timed out waiting for ${what}`);
    };
    for (const shape of ["launch", "malformed", "reroute"] as const) {
      const flagDir = mkdtempSync(join(tmpdir(), "tkr-retire-race-"));
      const first = join(flagDir, "first-pick"); // the waiting worker commits only once the other task's seat is launched
      const gated = (id: string) => ({ shell: `while [ ! -f ${shq(first)} ]; do sleep 0.05; done; echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
      // launch / malformed: T1 picks A first (A pending), T2 picks B, B cannot launch for T2, T2 re-routes to A and retires it.
      // reroute: T2 picks A first (A pending until T1's B launch begins); T1 picks B, B is pending until A retires and
      // then refuses both launches — the re-route finds only retired A.
      const t1First = shape !== "reroute";
      const runId = `run-race-${shape}`;
      const { repo, scriptPath } = setupRepo([T("T0"), T("T1", { deps: ["T0"] }), T("T2", { deps: ["T0"] })], { tasks: {
        T0: [work("z0", "t0.txt")], T1: [t1First ? work("t1", "t1.txt") : gated("t1")], T2: [t1First ? gated("t2") : work("t2", "t2.txt")],
      } }, reviewCfg(["seat-a", "seat-b"]));
      const retiredA = () => Journal.open(repo, runId).read().some((row) => row.event === "review-pool-demotion" && row.data.reviewer === A && Array.isArray(row.data.causes));
      let bForT1 = false;
      const { driver, seated } = launchDriver(async (seat, _n, task) => {
        if (seat === "seat-a" && task === (t1First ? "T1" : "T2")) {
          writeFileSync(first, "");
          if (t1First) await poll("A retired by T2", retiredA);
          else await poll("T1's B launch", () => bForT1);
          return shape === "launch" ? refused() : undefined;
        }
        if (seat === "seat-b" && task === (t1First ? "T2" : "T1")) {
          bForT1 = !t1First;
          if (!t1First) await poll("A retired by T2", retiredA);
          return refused();
        }
        return undefined;
      });
      const a = new Seat(scriptPath, "seat-a", { T0: "nonceless", T2: "nonceless", T1: shape === "malformed" ? "malformed" : "approve" });
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), a, new Seat(scriptPath, "seat-b")], runId, driver });
      const rows = rowsOf(repo, runId);
      expect(existsSync(first), shape).toBe(true);
      expect(rows.filter((row) => row.event === "review-pool-demotion").map((row) => row.data.reviewer), shape).toEqual([A]);
      // A reviews T1 only through the one dispatch picked before it retired — never a relaunch, re-emission or fallback.
      expect(seated.filter((x) => x === "seat-a/T1"), shape).toHaveLength(t1First ? 1 : 0);
      expect(of(rows, "review-infra-retry").filter((row) => row.data.reviewer === A && row.data.sameSeat === true), shape).toEqual([]);
      expect(of(rows, "review-reemission"), shape).toEqual([]);
      expect(reviewRows(rows).some((row) => row.data.pass === true && row.data.reviewer === A), shape).toBe(false);
      if (t1First) {
        // eligible B is dispatched for T1 and decides; T2 — whose pool A's retirement emptied — parks naming A.
        expect(s.done, shape).toEqual(["T0", "T1"]);
        expect(reviewRows(rows).at(-1)!.data, shape).toMatchObject({ pass: true, reviewer: B });
      } else expect(s.done, shape).toEqual(["T0", "T2"]);
      // The task whose pool retirement emptied records cannot-seat retired A and parks infrastructure naming it out for the run.
      const parked = t1First ? "T2" : "T1";
      expect(s.human, shape).toEqual([parked]);
      expect(rows.filter((row) => row.taskId === parked && row.event === "review-infra-retry" && row.data.cause === "retired").map((row) => row.data), shape)
        .toEqual([expect.objectContaining({ reviewer: A, cannotSeat: true })]);
      const park = rows.filter((row) => row.taskId === parked && row.event === "task-human").at(-1)!;
      expect(park.data.kind, shape).toBe("infra");
      expect(String(park.data.reason), shape).toContain(`cannot seat ${A}`);
      expect(String(park.data.reason), shape).toContain("out for the run");
      parkedReviewsAreInfra(rows, parked);
    }

    // Through production runGates: the same-seat launch-retry note is awaited while another task retires A.
    {
      // A carries one real no-verdict. T1's A launch fails; the observer of T1's review-infra-retry note awaits a
      // production runGates for T2, whose nonceless A answer is A's second real no-verdict. When that note returns,
      // T1 rechecks the live tally: retired A is never relaunched (nor re-asked or re-routed to), and B decides.
      const repo = makeRepo({ "a.txt": "x\n" });
      const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
      writeFileSync(join(repo, "a.txt"), "y\n");
      execSync(`${COMMIT} work`, { cwd: repo });
      const dir = mkdtempSync(join(tmpdir(), "tkr-note-race-"));
      const script = join(dir, "s.json");
      writeFileSync(script, JSON.stringify({ tasks: {} }));
      const author = new Author(script);
      const seats = [new Seat(script, "seat-a", { T1: "approve", T2: "nonceless" }), new Seat(script, "seat-b")];
      const { driver, seated } = launchDriver((seat, n, task) => seat === "seat-a" && task === "T1" && n === 1 ? refused() : undefined);
      const reviewNoVerdicts = new Map([[A, ["no-nonce"]]]);
      const demotedReviewers = new Set<string>();
      const events: [string, GateEvent][] = [];
      const baseline = await captureBaseline(repo, {});
      const cfg = { ...DEFAULT_CONFIG, judge: { ...DEFAULT_CONFIG.judge, adapter: "fake", model: "fake-1" },
        review: { ...DEFAULT_CONFIG.review, required: true, prefer: ["seat-a", "seat-b"], timeoutMs: 5000 } };
      let t2: Awaited<ReturnType<typeof runGates>> | undefined;
      const round = (id: string) => runGates(validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [{ id, title: id, goal: id, shape: "implement", complexity: 8, acceptance: [{ oracle: "command", command: "true" }] }] }).tasks[0]!, {
        worktree: repo, baseRef: base, result: { ok: true, summary: "s", deviations: [], raw: "" }, author: author.channels(cfg)[0]!,
        commands: {}, baseline, channels: [author, ...seats].flatMap((a) => a.channels(cfg)), adapters: [author, ...seats], cfg,
        via: { driver, nameFor: (role) => formatOwnedName({ role, taskId: id, attempt: 0, runId: "run-note-race" }), labelFor: (role) => `${role.toUpperCase()} ${id}` },
        reviewNoVerdicts, demotedReviewers,
        onGate: async (e: GateEvent) => {
          events.push([id, e]);
          if (id === "T1" && e.phase === "note" && e.name === "review-infra-retry") t2 = await round("T2");
        },
      });
      const t1 = await round("T1");
      const review = (r: Awaited<ReturnType<typeof runGates>>) => r.results.find((g) => g.gate === "review")!;
      expect(t2).toBeDefined();
      expect(reviewNoVerdicts.get(A)).toHaveLength(2);
      expect(seated).toEqual(["seat-a/T1", "seat-a/T2", "seat-b/T2", "seat-b/T1"]); // never A,A for T1
      expect(review(t2!)).toMatchObject({ pass: true, meta: { reviewer: B } });
      expect(review(t1)).toMatchObject({ pass: true, meta: { reviewer: B } });
      expect(review(t1).details).toContain(`review launch retry withdrawn: ${A} was retired for the run`);
      expect(events.some(([id, e]) => id === "T1" && e.phase === "note" && e.name === "review-reemission")).toBe(false);
    }

    // Through production runGates: an awaited read before or after every pick while another task retires A.
    {
      // A carries one real no-verdict. Under the judge-only policy T1's diff edits package.json beyond its version,
      // so every reviewGate call first awaits real git promotion reads BEFORE it picks; under the full policy it
      // picks first and then awaits its git diff read (and a pane seat its slot, and an Orca seat the runtime probe
      // and worktree lookup its create awaits) BEFORE it launches. A textconv hook holds the one ARMED read — or the
      // slot hold the one T1 pane, or the Orca transport T1's probe or lookup — until T2, a production runGates whose
      // nonceless A answer is A's second real no-verdict, has retired A. Whatever was picked before that
      // retirement, retired A is never launched for T1, at any of the four picks, under either policy.
      const poll = async (what: string, ok: () => boolean) => {
        for (let i = 0; i < 3000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
        if (!ok()) throw new Error(`timed out waiting for ${what}`);
      };
      const review = (r: Awaited<ReturnType<typeof runGates>>) => r.results.find((g) => g.gate === "review")!;
      for (const [policy, shape] of [
        ...(["initial", "launch", "malformed", "reroute"] as const).flatMap((shape) => [["promotion", shape], ["full", shape]] as const),
        ["full", "slot"] as const, ["full", "probe"] as const, ["full", "lookup"] as const,
      ]) {
        const alone = shape === "initial" || shape === "slot" || shape === "probe" || shape === "lookup";
        const name = `${policy} ${shape}`;
        const file = policy === "full" ? "src/a.ts" : "package.json";
        const repo = realpathSync(makeRepo(policy === "full" ? { "src/a.ts": "export const a = 1;\n" } : { "package.json": `{\n  "name": "x",\n  "version": "1.0.0"\n}\n` }));
        const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
        const hold = mkdtempSync(join(tmpdir(), "tkr-promotion-hold-"));
        const [arm, entered, release] = ["arm", "entered", "release"].map((f) => join(hold, f)) as [string, string, string];
        const hook = join(hold, "textconv.sh");
        writeFileSync(hook, `if mv ${shq(arm)} ${shq(entered)} 2>/dev/null; then while [ ! -f ${shq(release)} ]; do sleep 0.02; done; fi\ncat "$1"\n`);
        mkdirSync(join(repo, ".git", "info"), { recursive: true });
        writeFileSync(join(repo, ".git", "info", "attributes"), `${file} diff=hold\n`);
        execSync(`git config diff.hold.textconv ${shq(`sh ${shq(hook)}`)}`, { cwd: repo });
        writeFileSync(join(repo, file), policy === "full" ? "export const a = 2;\n" : `{\n  "name": "x",\n  "version": "1.0.0",\n  "scripts": { "test": "true" }\n}\n`);
        execSync(`${COMMIT} work`, { cwd: repo });
        const dir = mkdtempSync(join(tmpdir(), "tkr-promotion-race-"));
        const script = join(dir, "s.json");
        writeFileSync(script, JSON.stringify({ tasks: {} }));
        const author = new Author(script);
        const seats = [new Seat(script, "seat-a", { T1: shape === "malformed" ? "malformed" : "approve", T2: "nonceless" }), new Seat(script, "seat-b")];
        // launch: A's first T1 launch fails; reroute: B never launches for T1.
        let t1Launches = 0;
        // slot: T1's one pane is held at its creation, after its command was built for A.
        let slotHeld = false;
        const { driver, seated } = launchDriver((seat, _n, task) => task !== "T1" ? undefined
          : shape === "launch" && seat === "seat-a" && t1Launches++ === 0 ? refused()
          : shape === "reroute" && seat === "seat-b" ? refused() : undefined, undefined, async (pane) => {
          if (shape !== "slot" || slotHeld || !pane.startsWith("tickmarkr:review:T1:")) return;
          slotHeld = true;
          writeFileSync(entered, "");
          await poll(`${name}: release`, () => existsSync(release));
        });
        // probe / lookup: T1's seat is an OrcaDriver terminal whose create awaits the runtime probe and the worktree
        // lookup after onSlot; the transport holds the one named call there.
        const fake = new FakeOrca({ trackedWorktrees: [repo] });
        let orcaHeld = false;
        const t1Driver = shape === "probe" || shape === "lookup" ? new OrcaDriver({ launchingHandle: "term_launch", exec: async (args, cwd, timeoutMs) => {
          if (!orcaHeld && (shape === "probe" ? args[0] === "status" : args[0] === "worktree" && args[1] === "current")) {
            orcaHeld = true;
            writeFileSync(entered, "");
            await poll(`${name}: release`, () => existsSync(release));
          }
          return fake.exec(args, cwd, timeoutMs);
        } }) : driver;
        const reviewNoVerdicts = new Map([[A, ["no-nonce"]]]);
        const events: [string, GateEvent][] = [];
        const baseline = await captureBaseline(repo, {});
        const prefer = shape === "reroute" ? ["seat-b", "seat-a"] : ["seat-a", "seat-b"];
        const cfg = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, required: true, prefer, timeoutMs: 5000 } };
        // T1 is held at: the initial pick's read; the relaunch's read (armed by its review-infra-retry note); the
        // re-emission's read (armed by the malformed answer's note); the re-route's read (armed by B's second refusal);
        // the initial pick's pane creation (slot).
        if (shape === "initial") writeFileSync(arm, "");
        let t1Notes = 0;
        // A review-only round, exactly as the daemon's recovery round runs one: no other gate reads the diff.
        const round = (id: string, excludeReviewers: string[]) => runGates({ ...validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
          tasks: [{ id, title: id, goal: id, shape: "implement", complexity: 8, files: [file],
            acceptance: [{ oracle: "command", command: "true" }] }] }).tasks[0]!, gates: ["review"] }, {
          worktree: repo, baseRef: base, result: { ok: true, summary: "s", deviations: [], raw: "" }, author: author.channels(cfg)[0]!,
          commands: {}, baseline, channels: [author, ...seats].flatMap((a) => a.channels(cfg)), adapters: [author, ...seats], cfg,
          via: { driver: id === "T1" ? t1Driver : driver, nameFor: (role) => formatOwnedName({ role, taskId: id, attempt: 0, runId: "run-promotion-race" }), labelFor: (role) => `${role.toUpperCase()} ${id}` },
          reviewNoVerdicts, demotedReviewers: new Set<string>(), excludeReviewers,
          onGate: async (e: GateEvent) => {
            events.push([id, e]);
            if (id !== "T1" || e.phase !== "note") return;
            if (e.name === "review-no-verdict") t1Notes++;
            if ((shape === "launch" && e.name === "review-infra-retry") || (shape === "malformed" && e.name === "review-no-verdict")
              || (shape === "reroute" && e.name === "review-no-verdict" && t1Notes === 2)) writeFileSync(arm, "");
          },
        });
        // initial/slot/probe/lookup: B is out for T1, so retired A is its only candidate. T2 never seats B: A answers, then T2 has no one.
        const pending = round("T1", alone ? [B] : []);
        await poll(`${name}: T1 held inside its read or pane creation`, () => existsSync(entered));
        const t2 = await round("T2", [B]);
        writeFileSync(release, "");
        const t1 = await pending;
        expect(reviewNoVerdicts.get(A), name).toHaveLength(2);
        expect(review(t2).pass, name).toBe(false);
        expect(seated.filter((x) => x === "seat-a/T1"), name).toHaveLength(shape === "launch" || shape === "malformed" ? 1 : 0);
        expect(seated, name).toEqual({
          initial: ["seat-a/T2"],
          slot: ["seat-a/T2"],
          probe: ["seat-a/T2"],
          lookup: ["seat-a/T2"],
          launch: ["seat-a/T1", "seat-a/T2", "seat-b/T1"],
          malformed: ["seat-a/T1", "seat-a/T2", "seat-b/T1"],
          reroute: ["seat-b/T1", "seat-b/T1", "seat-a/T2"],
        }[shape]);
        expect(review(t1).pass === true && review(t1).meta?.reviewer === A, name).toBe(false);
        expect(events.some(([id, e]) => id === "T1" && e.phase === "note" && e.name === "review-reemission"), name).toBe(false);
        if (alone) expect(review(t1), name).toMatchObject({ pass: false, meta: { noEligibleReviewer: true } });
        // The Orca seat's guard runs at the create submission itself: no terminal was ever created for retired A.
        if (shape === "probe" || shape === "lookup") expect([orcaHeld, fake.countOf("create")], name).toEqual([true, 0]);
        if (shape === "launch") expect(review(t1).details, name).toContain(`review launch retry withdrawn: ${A} was retired for the run`);
        if (shape === "launch" || shape === "malformed") expect(review(t1), name).toMatchObject({ pass: true, meta: { reviewer: B } });
        if (shape === "reroute") expect(review(t1), name).toMatchObject({ pass: false, meta: { noVerdict: true, infra: true } });
        // Picked before it retired, refused at launch: the round says so.
        if (policy === "full") expect(review(t1).details, name).toMatch(new RegExp(`withdrawn: ${A} was retired for the run`));
      }
    }
  });

  test("production runDaemon preserves the rejecting pending judge in the seven-gate table versus merge after complete exact-candidate proof", async () => {
    const fail = { pass: false, criteria: [{ criterion: "c1", met: false, reason: "work.txt lacks the behavior" }] };
    const pass = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] };
    for (const [name, judge] of [["rejecting", [fail, pass]], ["approving", [pass]]] as const) {
      const runId = `run-seven-${name}`;
      const { repo, scriptPath } = setupRepo([T("T1")], {
        judge, consult: { action: "retry", notes: "fix it" }, tasks: { T1: [work("s0"), work("s1", "fix.txt")] },
      }, reviewCfg(["seat-a"]) + "gates: { test: \"true\" }\n");
      // The judge stays pending until the review's relaunch has been dispatched: the launch failure and its
      // recovery happen beside an unanswered acceptance judge.
      let relaunched!: () => void;
      const recovered = new Promise<void>((resolve) => { relaunched = resolve; });
      let held = false;
      const { driver, launches } = launchDriver((seat, n) => {
        if (seat === "seat-a" && n === 2) relaunched();
        return seat === "seat-a" && n === 1 ? refused() : undefined;
      }, async () => { if (!held) { held = true; await recovered; } });
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a")], runId, driver });
      expect(s.done, name).toEqual(["T1"]);
      expect(launches.slice(0, 2), name).toEqual(["seat-a", "seat-a"]);
      const rows = rowsOf(repo, runId);
      const at = (match: (e: JournalEvent) => boolean) => rows.findIndex(match);
      const mergeAt = at((e) => e.event === "merge" && e.taskId === "T1");
      expect(mergeAt, name).toBeGreaterThan(0);
      const gates = of(rows, "gate-result");
      if (name === "rejecting") {
        // The judge's eventual rejecting row stands beside the recovered approving review: the round does not merge.
        const red = gates.find((row) => row.data.gate === "acceptance" && row.data.pass === false)!;
        expect(red, name).toBeDefined();
        const redAt = rows.indexOf(red);
        const firstReview = gates.find((row) => row.data.gate === "review" && row.data.pass === true)!;
        expect(firstReview.data.reviewer, name).toBe(A);
        expect(rows.indexOf(firstReview) < mergeAt && redAt < mergeAt, name).toBe(true);
        const nextRound = rows.findIndex((row, i) => i > redAt && row.taskId === "T1" && row.event === "phase-start" && row.data.phase === "gates");
        expect(nextRound, name).toBeGreaterThan(redAt);
        expect(nextRound, name).toBeLessThan(mergeAt);
        expect(of(rows, "task-dispatch"), name).toHaveLength(2);
      } else expect(of(rows, "task-dispatch"), name).toHaveLength(1);
      // The merge lands only after every enabled gate passed on the exact merge candidate.
      const lastRound = rows.findLastIndex((row, i) => i < mergeAt && row.taskId === "T1" && row.event === "phase-start" && row.data.phase === "gates");
      const final = rows.slice(lastRound, mergeAt).filter((row) => row.taskId === "T1" && row.event === "gate-result");
      for (const gate of ["acceptance", "review", "test"]) {
        expect(final.some((row) => row.data.gate === gate && row.data.pass === true), `${name} ${gate}`).toBe(true);
      }
      expect(final.every((row) => row.data.pass !== false), name).toBe(true);
      const candidate = final.find((row) => row.data.gate === "test")!.data.commit;
      expect(candidate, name).toBeDefined();
      // one gate subject identity across the passing battery — the exact merge candidate
      for (const row of final) if (row.data.commit !== undefined) expect(row.data.commit, `${name} ${String(row.data.gate)}`).toBe(candidate);
    }
  });
});
