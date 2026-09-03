import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { USAGE } from "../../src/cli/index.js";
import { DRIVER_CHOICES } from "../../src/drivers/index.js";
import { canonicalWorktreePath, OrcaDriver, OrcaError, parseEnvelope, resolveOrcaCliBinary, terminalWorktree, type OrcaExec } from "../../src/drivers/orca.js";
import type { Slot } from "../../src/drivers/types.js";
import { removeWorktree, sh, shGit, shOk, type ShResult } from "../../src/run/git.js";

/**
 * Real-Orca smoke for the shipped OrcaDriver. Self-gated twice over: it runs only when
 * TICKMARKR_E2E=1 AND the runtime probe answers reachable, and even then it launches NO agent CLI —
 * the terminal runs two `printf`s that emit a synthetic per-run nonce trailer, so the smoke spends
 * zero tokens. What it proves is exactly what a fake can never prove: a real `terminal create`
 * receipt binds to the worktree the smoke made, real cursor-paged reads carry the trailer back
 * byte-exact, and the real close removes the terminal.
 *
 * Fail-closed by construction: `smokeVerdict` is the ONLY place a green is minted, and it mints one
 * only from observations that were actually made. A missing observation is a failure, never a
 * default pass; a missing gate or runtime yields status "skipped" with a stated reason, which the
 * live leg turns into a vitest skip — never a claimed observation, and never a pass that reads as
 * "orca was smoked".
 */

const NONCE = `SMOKE${randomBytes(3).toString("hex").toUpperCase()}`;
// Deliberately short: it must land on one terminal row un-wrapped for the byte-exact read to mean
// what it says. Same shape as the worker trailer (src/adapters/prompt.ts), a nonce of its own.
const TRAILER = `TICKMARKR_RESULT_${NONCE} {"ok":true,"summary":"smoke","deviations":[]}`;
// The trailer is emitted in two fragments split MID-TOKEN, as the conformance spike does
// (.planning/assessments/orca-conformance-spike.mjs:243-245). Orca terminals are interactive, so the
// shell echoes the command line back into the same scrollback the smoke reads: a command carrying
// the whole trailer verbatim would satisfy waitOutput and the byte-exact read on its own ECHO, green
// with printf never having run. Split, the contiguous byte sequence exists only in executed output —
// the echo shows the fragments separated by the shell syntax between them.
const TRAILER_HEAD = "TICKMARKR_RES";
const TRAILER_TAIL = TRAILER.slice(TRAILER_HEAD.length);
const TRAILER_TIMEOUT_MS = 60_000;
const LIVE_LEG_TIMEOUT_MS = 300_000; // the vitest timeout on the live leg below
// Every orca CLI call this smoke makes is bounded here, well under that leg timeout: `sh` otherwise
// waits its own 600_000ms default, so ONE hung `orca status` would outlive the leg and red it on a
// vitest timeout instead of skipping. An orca that will not answer within this is an unreachable
// orca — the bounded call fails, and probeReachable classifies that as unreachable, which is the
// runner-visible skip criterion 2 requires. Generous for a single CLI round-trip.
const CALL_TIMEOUT_MS = 25_000;
const WORKTREE_TIMEOUT_MS = 60_000; // measured: orca picked a fresh worktree up in 0.1s once and 13.5s the next time
const IDLE_SECONDS = 20;
// The ONLY close refusal this smoke tolerates: orca removes a live terminal and then answers
// `{"code":"runtime_error","message":"tab_not_found"}` for the tab it just took away (observed on
// 1.4.186 and again on 1.4.188, so the tolerance is not pinned to one build). Matched as the WHOLE
// parsed refusal — parseEnvelope renders exactly `refused (<code>: <message>)`, so equality here
// pins both fields — never as a substring anywhere in the combined message or the raw body. A
// transport failure that merely quotes those bytes is a different event, and reading it as this one
// is how an outright-rejected close ships green. Every other close failure stays a failure.
const TOLERATED_CLOSE_REASON = "refused (runtime_error: tab_not_found)";

type SmokeStatus = "passed" | "skipped" | "failed";

interface SmokeObservations {
  /** TICKMARKR_E2E=1 */
  gate: boolean;
  /** probeRuntime answered with a live runtime id AND that runtime resolves the smoke's checkout */
  reachable: boolean;
  /** why the runtime was not usable, when it was not */
  unreachable?: string;
  /** the temporary worktree this smoke created and asked orca to bind the terminal to */
  smokeWorktree?: string;
  /** the worktree orca's own create receipt named (canonicalized), or undefined when unbound */
  createReceiptWorktree?: string;
  /** the nonce trailer came back contiguous and byte-exact through OrcaDriver reads */
  trailerObserved: boolean;
  /** driver.status() deliberately exercised an elapsed terminal wait against the installed Orca */
  elapsedWaitExercised: boolean;
  /** the runtime identity that ANSWERED the create — orca handles are runtime-scoped, so this is
   *  the only identity against which this handle's presence or absence means anything */
  createRuntimeId?: string;
  /** the runtime that answered the pre-close listing */
  listedBeforeRuntimeId?: string;
  /** the same runtime listed the created handle immediately BEFORE the close attempt */
  listedBeforeClose: boolean;
  /** the runtime that answered the post-close listing */
  closedRuntimeId?: string;
  /** after close(), orca no longer lists the created handle for the smoke's worktree */
  terminalClosed: boolean;
  /** the ONE documented refusal (tab_not_found) orca 1.4.186 answers a live close with, recorded
   *  rather than hidden; every other close failure is a smoke failure, never a tolerated one */
  closeRefused?: string;
}

interface SmokeResult {
  status: SmokeStatus;
  reasons: string[];
  observations: SmokeObservations;
}

/** The verdict rule, written before the first run. Green requires every observation to have been
 *  MADE — a smoke that reports green while an observation is missing is a failed smoke. */
export function smokeVerdict(o: SmokeObservations): { status: SmokeStatus; reasons: string[] } {
  if (!o.gate) return { status: "skipped", reasons: ["TICKMARKR_E2E is not 1"] };
  if (!o.reachable) return { status: "skipped", reasons: [o.unreachable ?? "orca runtime is not reachable"] };
  const reasons: string[] = [];
  if (!o.trailerObserved) reasons.push("no byte-exact nonce trailer observed through OrcaDriver reads");
  if (!o.elapsedWaitExercised) reasons.push("no elapsed terminal wait exercised through OrcaDriver status");
  if (o.smokeWorktree === undefined || o.createReceiptWorktree !== o.smokeWorktree) {
    reasons.push(`create receipt bound to ${o.createReceiptWorktree ?? "no worktree"}, not the smoke's ${o.smokeWorktree ?? "unknown"}`);
  }
  if (!o.listedBeforeClose) {
    reasons.push("orca never listed the created terminal before the close attempt — a later absence proves no close");
  }
  if (!o.terminalClosed) reasons.push("terminal was not closed");
  // Handles are runtime-scoped: a restart between the two listings retires every handle the old
  // runtime held, so the post-close absence would be unanimous whether or not anything was closed.
  // Both listings must come from the identity that minted the handle, or the close is unproven.
  if (o.createRuntimeId === undefined
    || o.listedBeforeRuntimeId !== o.createRuntimeId
    || o.closedRuntimeId !== o.createRuntimeId) {
    reasons.push(
      `close evidence spans runtimes: created under ${o.createRuntimeId ?? "no runtime"}, listed before under ${o.listedBeforeRuntimeId ?? "none"}, after under ${o.closedRuntimeId ?? "none"} — an absence across a runtime change proves no close`,
    );
  }
  return { status: reasons.length > 0 ? "failed" : "passed", reasons };
}

interface OrcaCall { args: string[]; result: ShResult }

/** The production exec, plus a tape: every envelope orca actually answered stays readable so the
 *  smoke can observe the create RECEIPT rather than trust that the driver checked it. `run` is a
 *  seam so the bound below is assertable without a hung orca. */
export function recordingExec(tape: OrcaCall[], run: typeof sh = sh): OrcaExec {
  return async (args, cwd, timeoutMs) => {
    // Bounded by default — the driver leaves timeoutMs undefined on `status` and the reads, and
    // sh's 600s default is twice the live leg's ceiling (CALL_TIMEOUT_MS).
    const binary = resolveOrcaCliBinary(cwd) ?? "orca";
    const result = await run([binary, ...args].map(shq).join(" "), cwd, timeoutMs ?? CALL_TIMEOUT_MS);
    tape.push({ args, result });
    return result;
  };
}

function elapsedWaitSeen(tape: OrcaCall[]): boolean {
  return tape.some(({ args, result }) => {
    if (args[0] !== "terminal" || args[1] !== "wait" || !args.includes("tui-idle") || result.code !== 1) return false;
    try {
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      const error = typeof body.error === "object" && body.error !== null ? body.error as Record<string, unknown> : {};
      const wait = typeof body.result === "object" && body.result !== null
        ? (body.result as Record<string, unknown>).wait
        : undefined;
      return (body.ok === false && error.code === "timeout")
        || (body.ok === true
          && typeof wait === "object"
          && wait !== null
          && (wait as Record<string, unknown>).satisfied === false);
    } catch {
      return false;
    }
  });
}

function createReceipt(tape: OrcaCall[]): { handle?: string; worktree?: string; runtimeId?: string } {
  const call = tape.find((c) => c.args[0] === "terminal" && c.args[1] === "create");
  if (!call) return {};
  // The create's own `_meta.runtimeId`, kept rather than discarded: the handle below is scoped to
  // THIS identity, so every later claim about it — listed, refused, absent — only counts when the
  // same runtime answered.
  const env = parseEnvelope("create", call.result.stdout);
  const term = env.result.terminal;
  if (typeof term !== "object" || term === null || Array.isArray(term)) return { runtimeId: env.runtimeId };
  const record = term as Record<string, unknown>;
  const worktree = terminalWorktree(record);
  return {
    handle: typeof record.handle === "string" ? record.handle : undefined,
    worktree: worktree === undefined ? undefined : canonicalWorktreePath(worktree),
    runtimeId: env.runtimeId,
  };
}

/**
 * Orca resolves a `path:` selector against the worktrees it currently lists, and it picks a freshly
 * created git worktree up on its own refresh — so the selector can be unknown for a moment after
 * createWorktree returns. Bounded wait for the checkout to be resolvable at all; the create that
 * follows is what actually proves the binding.
 */
async function awaitWorktreeListed(exec: OrcaExec, cwd: string, worktree: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await exec(["worktree", "list", "--json"], cwd);
    const rows = parseEnvelope("list", r.stdout).result.worktrees;
    const listed = Array.isArray(rows) && rows.some((w) => {
      const path = typeof w === "object" && w !== null ? (w as Record<string, unknown>).path : undefined;
      return typeof path === "string" && canonicalWorktreePath(path) === worktree;
    });
    if (listed) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

/**
 * The smoke's ONE reachability question, asked exactly the way production asks it: `probeRuntime`
 * defines a reachable orca, and nothing is layered on top of it. Its refusal is not a failure —
 * there is simply no orca here to smoke. Once it resolves, the skip conditions are OVER: an orca
 * that answers the probe and then will not surface a terminal is a RED, because a second gate here
 * would let exactly the runtime states this smoke exists to catch slip out as a skip.
 *
 * A HUNG runtime is an unreachable one: the probe's `orca status` is bounded at CALL_TIMEOUT_MS by
 * the smoke's exec, so it throws well inside the live leg's timeout and lands here — a skip, never
 * a vitest timeout that reds the leg.
 */
export async function probeReachable(
  driver: OrcaDriver,
  cwd: string,
  probeRuntime?: (driver: OrcaDriver, cwd: string) => Promise<string>,
): Promise<{ reachable: boolean; unreachable?: string }> {
  try {
    await (probeRuntime ?? ((d, dir) => d.probeRuntime(dir)))(driver, cwd);
    return { reachable: true };
  } catch {
    return { reachable: false, unreachable: "orca runtime is not reachable" };
  }
}

async function listsHandle(exec: OrcaExec, cwd: string, worktree: string, handle: string): Promise<{ listed: boolean; runtimeId: string }> {
  const r = await exec(["terminal", "list", "--worktree", `path:${worktree}`, "--limit", "10000", "--json"], cwd);
  // A listing that exited nonzero or was killed on timeout is not a listing, however parseable the
  // stdout left behind looks: a crashed or half-written body missing the still-open row would read
  // as "closed". Fail closed before the bytes are trusted at all.
  if (r.code !== 0 || r.timedOut === true) {
    throw new Error(`terminal list exited ${r.code}${r.timedOut ? " after timeout" : ""} — its stdout cannot testify about ${handle}`);
  }
  const env = parseEnvelope("list", r.stdout);
  // A CAPPED listing cannot prove absence: the row it dropped could be the still-open handle, and
  // reading that omission as "closed" is exactly how a close failure would mint a green. Fail closed
  // — the caller records this throw as a smoke failure (same rule the driver applies, orca.ts:886).
  if (env.result.truncated === true) {
    throw new Error(`terminal list is truncated at ${String(env.result.totalCount ?? "unknown")} rows — the absence of ${handle} cannot prove it closed`);
  }
  const listed = env.result.terminals;
  if (!Array.isArray(listed)) throw new Error("terminal list carries no terminals array");
  return {
    listed: listed.some((t) => typeof t === "object" && t !== null && (t as Record<string, unknown>).handle === handle),
    // The identity that answered THIS listing. parseEnvelope already refuses an ok body without a
    // usable `_meta.runtimeId`, so this is always a real identity — the caller compares it to the
    // create's, because a handle's absence only means "closed" under the runtime that minted it.
    runtimeId: env.runtimeId,
  };
}

/**
 * One smoke run. `gate` and `probeRuntime` are seams so the skip paths are exercisable without an
 * orca — nothing else is faked: the driver, the CLI, the worktree and the terminal are real.
 */
export async function runOrcaSmoke(opts: {
  gate?: boolean;
  probeRuntime?: (driver: OrcaDriver, cwd: string) => Promise<string>;
} = {}): Promise<SmokeResult> {
  const observations: SmokeObservations = {
    gate: opts.gate ?? process.env.TICKMARKR_E2E === "1",
    reachable: false,
    trailerObserved: false,
    elapsedWaitExercised: false,
    listedBeforeClose: false,
    terminalClosed: false,
  };
  const settle = (extra: string[] = []): SmokeResult => {
    const v = smokeVerdict(observations);
    return { status: v.status, reasons: [...v.reasons, ...extra], observations };
  };
  if (!observations.gate) return settle();

  const cwd = process.cwd();
  const tape: OrcaCall[] = [];
  const exec = recordingExec(tape);
  const driver = new OrcaDriver({ exec });
  const probed = await probeReachable(driver, cwd, opts.probeRuntime);
  observations.reachable = probed.reachable;
  observations.unreachable = probed.unreachable;
  // An absent runtime skips; it never passes and never reds. Everything past this point is a real
  // orca, so from here on a missing observation is a FAILURE — the skip conditions end here.
  if (!probed.reachable) return settle();

  const failures: string[] = [];
  const repo = (await shOk("git rev-parse --show-toplevel", cwd)).trim();
  const branch = `orca-smoke-${NONCE.toLowerCase()}`;
  // tickmarkr's own checkout authority — the same primitive a real run uses. orca never makes it.
  const worktree = await driver.worktree(repo, branch, "HEAD");
  let slot: Slot | undefined;
  try {
    slot = await driver.slot(worktree, branch, {
      owned: { role: "watch", taskId: "ORCASMOKE", attempt: 0, runId: NONCE },
    });
    observations.smokeWorktree = slot.cwd;
    if (!await awaitWorktreeListed(exec, cwd, slot.cwd, WORKTREE_TIMEOUT_MS)) {
      // A RED, not a skip: the runtime answered the reachability probe, so a checkout it will not resolve
      // is a failure to establish the very binding this smoke exists to prove. Reclassifying it as
      // "unreachable" here would bypass the trailer, receipt and close checks with a green run.
      throw new Error(`orca does not resolve the smoke's worktree ${slot.cwd} within ${WORKTREE_TIMEOUT_MS}ms — the create receipt can never be bound`);
    }
    // The whole payload: two printfs emitting the split trailer, then an idle sleep the close will
    // kill. No agent CLI is launched, so no tokens are spent; the sleep only keeps the terminal
    // alive to be closed, since orca reaps the tab of a command that has already exited (observed:
    // close → tab_not_found). Neither fragment is the trailer, so the echoed command line cannot
    // satisfy the observation below — only the executed printfs can.
    await driver.run(
      slot,
      `printf '%s' ${shq(TRAILER_HEAD)}; printf '%s\\n' ${shq(TRAILER_TAIL)}; sleep ${IDLE_SECONDS}`,
    );
    const receipt = createReceipt(tape);
    observations.createReceiptWorktree = receipt.worktree;
    observations.createRuntimeId = receipt.runtimeId;
    // waitOutput tolerates renderer wrapping; the unpaged read is the byte-exact leg.
    const matched = await driver.waitOutput(slot, TRAILER, TRAILER_TIMEOUT_MS);
    await driver.status(slot);
    observations.elapsedWaitExercised = elapsedWaitSeen(tape);
    observations.trailerObserved = matched && (await driver.read(slot, 200)).includes(TRAILER);
    if (receipt.handle === undefined) throw new Error("the create receipt carries no handle — no close can be proven against it");
    if (receipt.runtimeId === undefined) throw new Error("the create receipt carries no runtime identity — its handle is scoped to nothing provable");
    // Presence FIRST, from the same runtime and the same listing the absence will be read from. An
    // absence on its own proves nothing: a terminal that died on its own, or one this runtime never
    // held, is missing from the later list exactly like a closed one — and reading that as green is
    // how a close that never happened would ship. The answering identity is recorded with it, and
    // smokeVerdict requires both listings to be the create's own runtime.
    const before = await listsHandle(exec, cwd, worktree, receipt.handle);
    observations.listedBeforeClose = before.listed;
    observations.listedBeforeRuntimeId = before.runtimeId;
    // Orca answers a LIVE terminal's close with a tab_not_found refusal while still removing it, so
    // that one documented response is tolerated and recorded — matched on the envelope's exact
    // refusal CODE, from the very runtime that minted the handle. Anything else — a different
    // refusal code, a refusal from another identity, a transport failure, a receipt that does not
    // prove the close — is a smoke failure: swallowing it is how a rejected close reads as done.
    try {
      await driver.close(slot);
    } catch (e) {
      if (!(e instanceof OrcaError) || e.reason !== TOLERATED_CLOSE_REASON || e.runtimeId !== receipt.runtimeId) {
        throw new Error(`terminal close failed: ${(e as Error).message}`);
      }
      observations.closeRefused = `${e.reason} from ${e.runtimeId}`;
    }
    slot = undefined;
    const after = await listsHandle(exec, cwd, worktree, receipt.handle);
    observations.terminalClosed = !after.listed;
    observations.closedRuntimeId = after.runtimeId;
  } catch (e) {
    failures.push(`smoke threw: ${(e as Error).message}`);
  } finally {
    if (slot) await driver.close(slot).catch(() => undefined);
    await removeWorktree(repo, worktree);
    await shGit(`git branch -D ${shq(branch)}`, repo);
  }
  return settle(failures);
}

/** One live leg per file: the criterion tests below read this single result, they never re-run it. */
let live: Promise<SmokeResult> | undefined;
const liveSmoke = (): Promise<SmokeResult> => (live ??= runOrcaSmoke());

const LIVE_TITLE = "live: the real-orca terminal leg — vitest-skipped without the gate or a reachable runtime";

/** Just enough of vitest's TestContext to leave a test through the runner's own skip channel. */
type SkipChannel = { skip: () => void };

/** Just enough of a collected vitest task to read the runner's own verdict off it. */
type RunnerTask = { name: string; mode: string; result?: { state?: string } };

/**
 * Vitest's OWN report of the live leg, read out of the runner's task tree rather than from anything
 * the leg says about itself. `ctx.skip()` earns "skip"; a leg that returned normally on absence is
 * counted "pass" — the silent pass criterion 2 forbids. "unscheduled" is what a single-name filter
 * leaves behind (the acceptance gate runs `vitest -t "<criterion>"`, so the live leg is not
 * collected to run at all) — which is exactly why the stub-driven proof below stands on its own.
 */
export function liveLegState(siblings: readonly RunnerTask[]): string {
  const leg = siblings.find((t) => t.name === LIVE_TITLE);
  if (leg === undefined) return "unscheduled";
  return leg.result?.state ?? (leg.mode === "run" ? "unfinished" : "unscheduled");
}

/**
 * The live leg's WHOLE body — the bytes vitest runs for LIVE_TITLE, and the same bytes criterion 2
 * drives with a recording skip channel. Absence leaves through `ctx.skip()`, so the runner counts
 * the leg under "skipped"; it never returns normally on absence, which is the silent pass that
 * would be counted under "passed". (Under real vitest `ctx.skip()` throws, so the return below is
 * unreachable there — it is what makes the exit observable to a stub.)
 */
export async function liveLeg(ctx: SkipChannel, smoke: SmokeResult): Promise<"skipped" | "ran"> {
  if (smoke.status === "skipped") {
    expect(smoke.reasons.length, "a skipped smoke must say why it did not run").toBeGreaterThan(0);
    expect(smoke.observations.trailerObserved).toBe(false);
    console.warn(`orca smoke ${NONCE} NOT RUN — ${smoke.reasons.join(" · ")}`);
    ctx.skip();
    return "skipped";
  }
  // The smoke's evidence, printed when it actually ran: a green here is a claim until it is read.
  console.log(`orca smoke ${NONCE}: ${JSON.stringify(smoke)}`);
  expect(smoke.reasons, "smoke reasons must be empty to pass").toEqual([]);
  expect(smoke.status).toBe("passed");
  expect(smoke.observations.trailerObserved).toBe(true);
  expect(smoke.observations.elapsedWaitExercised).toBe(true);
  expect(smoke.observations.createReceiptWorktree).toBe(smoke.observations.smokeWorktree);
  expect(smoke.observations.listedBeforeClose).toBe(true);
  expect(smoke.observations.terminalClosed).toBe(true);
  expect(smoke.observations.listedBeforeRuntimeId).toBe(smoke.observations.createRuntimeId);
  expect(smoke.observations.closedRuntimeId).toBe(smoke.observations.createRuntimeId);
  return "ran";
}

describe("e2e: orca driver smoke", () => {
  // This is the ONLY place the live smoke touches the reporter: an absent gate or runtime ends in
  // ctx.skip(), so vitest counts it under "skipped" and never under "passed". The criterion-titled
  // tests stay ordinary tests that always run — each one stands on its own, so a name filter that
  // selects a single criterion still executes it in full (src/gates/acceptance.ts testsRan).
  test(LIVE_TITLE, async (ctx) => {
    await liveLeg(ctx, await liveSmoke());
  }, LIVE_LEG_TIMEOUT_MS);

  test("with the e2e gate set and a reachable runtime the smoke observes its synthetic nonce trailer byte-exact through OrcaDriver reads in a terminal whose create receipt binds to the smoke's temporary worktree and closes it while a smoke that reports green without the trailer observation or the receipt binding fails", async () => {
    // The mutants: each is a smoke claiming green with one observation missing. None may pass.
    const green: SmokeObservations = {
      gate: true,
      reachable: true,
      smokeWorktree: "/tmp/smoke-wt",
      createReceiptWorktree: "/tmp/smoke-wt",
      trailerObserved: true,
      elapsedWaitExercised: true,
      createRuntimeId: "rt-1",
      listedBeforeRuntimeId: "rt-1",
      listedBeforeClose: true,
      closedRuntimeId: "rt-1",
      terminalClosed: true,
    };
    expect(smokeVerdict(green).status).toBe("passed");
    expect(smokeVerdict({ ...green, trailerObserved: false }).status).toBe("failed");
    expect(smokeVerdict({ ...green, elapsedWaitExercised: false }).status).toBe("failed");
    expect(smokeVerdict({ ...green, createReceiptWorktree: "/tmp/some-other-wt" }).status).toBe("failed");
    expect(smokeVerdict({ ...green, createReceiptWorktree: undefined }).status).toBe("failed");
    expect(smokeVerdict({ ...green, terminalClosed: false }).status).toBe("failed");
    // Absence alone is not a close: a handle the runtime never listed before the attempt is missing
    // afterwards whether or not this smoke closed anything.
    expect(smokeVerdict({ ...green, listedBeforeClose: false }).status).toBe("failed");
    // Handles are runtime-scoped, so a restart makes the absence unanimous and meaningless. Neither
    // listing may come from another identity, and a create that named no identity proves nothing.
    expect(smokeVerdict({ ...green, closedRuntimeId: "rt-2" }).status).toBe("failed");
    expect(smokeVerdict({ ...green, listedBeforeRuntimeId: "rt-2" }).status).toBe("failed");
    expect(smokeVerdict({ ...green, createRuntimeId: undefined }).status).toBe("failed");
    expect(smokeVerdict({ ...green, closedRuntimeId: undefined }).status).toBe("failed");

    // The live observations, when the leg above ran: gated and reachable, only a real observed
    // trailer and a bound receipt pass. Absent orca that leg is SKIPPED, and this criterion stands
    // on the mutants — the absence is never dressed up as an observation.
    const smoke = await liveSmoke();
    if (smoke.status !== "skipped") {
      expect(smoke.status, `live smoke: ${smoke.reasons.join(" · ")}`).toBe("passed");
      expect(smoke.observations.trailerObserved).toBe(true);
      expect(smoke.observations.elapsedWaitExercised).toBe(true);
      expect(smoke.observations.createReceiptWorktree).toBe(smoke.observations.smokeWorktree);
      expect(smoke.observations.listedBeforeClose).toBe(true);
      expect(smoke.observations.terminalClosed).toBe(true);
      expect(smoke.observations.listedBeforeRuntimeId).toBe(smoke.observations.createRuntimeId);
      expect(smoke.observations.closedRuntimeId).toBe(smoke.observations.createRuntimeId);
    }
  }, LIVE_LEG_TIMEOUT_MS);

  test("the e2e smoke exercises an elapsed terminal wait on the installed Orca deliberately so it reports skipped as a loud tri-state result rather than a silent pass when no runtime answers as the diff shows in the changed smoke hunks", async (ctx) => {
    const ungated = await runOrcaSmoke({ gate: false });
    expect(ungated.status).toBe("skipped");
    expect(ungated.reasons).toEqual(["TICKMARKR_E2E is not 1"]);
    expect(ungated.observations.reachable).toBe(false);

    const unreachable = await runOrcaSmoke({
      gate: true,
      probeRuntime: () => Promise.reject(new Error("runtime reports reachable:false")),
    });
    expect(unreachable.status).toBe("skipped");
    expect(unreachable.reasons).toEqual(["orca runtime is not reachable"]);

    // An UNRESPONSIVE runtime is unreachable too, and it must say so inside the live leg's own
    // timeout: the probe's `orca status` carries no timeout of its own, so an unbounded exec would
    // sit on sh's 600s default — twice the leg's ceiling — and red the leg on a vitest timeout
    // instead of skipping. Assert the ceiling the exec actually hands the shell, then that a call
    // killed at it lands as a skip. (The stub is the kill sh reports: rc 137, timedOut, no stdout.)
    const ceilings: number[] = [];
    const hungShell: typeof sh = async (_cmd, _cwd, timeoutMs) => {
      ceilings.push(timeoutMs ?? Number.POSITIVE_INFINITY);
      return { code: 137, stdout: "", stderr: "", timedOut: true };
    };
    const hung = await runOrcaSmoke({
      gate: true,
      probeRuntime: (_d, dir) => new OrcaDriver({ exec: recordingExec([], hungShell) }).probeRuntime(dir),
    });
    expect(hung.status).toBe("skipped");
    expect(hung.reasons).toEqual(["orca runtime is not reachable"]);
    expect(ceilings.length, "the probe must have reached the shell").toBeGreaterThan(0);
    expect(Math.max(...ceilings), "every orca call must be bounded below the live leg's timeout")
      .toBeLessThan(LIVE_LEG_TIMEOUT_MS);

    // Absent orca, no set of claimed observations may mint a pass — skipping is the only outcome.
    const claimsGreen: SmokeObservations = {
      gate: false,
      reachable: false,
      smokeWorktree: "/tmp/smoke-wt",
      createReceiptWorktree: "/tmp/smoke-wt",
      trailerObserved: true,
      elapsedWaitExercised: true,
      listedBeforeClose: true,
      terminalClosed: true,
    };
    expect(smokeVerdict(claimsGreen).status).toBe("skipped");
    expect(smokeVerdict({ ...claimsGreen, gate: true }).status).toBe("skipped");

    // And the RUNNER's own skip channel, driven through the exact body vitest runs for the live leg
    // (liveLeg, above) rather than read off some other task's report — so this criterion proves it
    // whether it runs beside its siblings or alone under a single-name filter. `ctx.skip()` is what
    // makes vitest count the leg under "skipped"; a leg that returned without touching it would be
    // counted under "passed", which is the silent pass this criterion forbids.
    let skipped = 0;
    const channel = { skip: () => { skipped += 1; } };
    expect(await liveLeg(channel, ungated)).toBe("skipped");
    expect(await liveLeg(channel, unreachable)).toBe("skipped");
    expect(skipped, "an absent gate and an absent runtime must each leave through ctx.skip()").toBe(2);

    // And when this file ran whole, the RUNNER's own tally for the live leg beside us: absent orca it
    // must sit under "skip", never under "pass". This is vitest's report, not the leg's self-account —
    // the leg the previous shape shipped returned normally on absence and was counted "pass" here.
    const liveHere = await liveSmoke();
    if (liveHere.status === "skipped") {
      expect(liveHere.reasons.length, "a skipped live smoke must say why it did not run").toBeGreaterThan(0);
      const state = liveLegState(ctx.task.suite?.tasks ?? []);
      expect(state, "vitest must never count the absent-orca live leg as passed").not.toBe("pass");
      // Under a single-name filter the leg is never scheduled; whenever it WAS, only a skip passes.
      if (state !== "unscheduled") expect(state).toBe("skip");
    }
    // …and that read is not vacuous: fed the runner's tally for a leg that returned normally, it
    // reports exactly the "pass" the assertion above refuses.
    expect(liveLegState([{ name: LIVE_TITLE, mode: "run", result: { state: "pass" } }])).toBe("pass");
    expect(liveLegState([{ name: LIVE_TITLE, mode: "run", result: { state: "skip" } }])).toBe("skip");

    // The mutant, run against the same assertions: a leg that returns normally on absence. It never
    // reaches the skip channel, so the count above is what reds on it.
    const silentLeg = async (_c: typeof channel, _s: SmokeResult): Promise<"skipped" | "ran"> => "ran";
    let mutantSkips = 0;
    expect(await silentLeg({ skip: () => { mutantSkips += 1; } }, ungated)).not.toBe("skipped");
    expect(mutantSkips).toBe(0);
  }, 60_000);

  test("the CLI usage text offers orca among the driver choices while usage that still enumerates only auto, herdr and subprocess fails", () => {
    const offersOrca = (usage: string): boolean => {
      const line = usage.split("\n").find((l) => l.includes("--driver"));
      return line !== undefined && DRIVER_CHOICES.every((choice) => line.includes(choice));
    };
    expect(offersOrca(USAGE)).toBe(true);
    expect(offersOrca("  run  execute the graph (--concurrency N --driver auto|herdr|subprocess --route-strict)")).toBe(false);
  });
});
