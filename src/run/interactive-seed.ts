import { matchesTrustDialog, type Assignment, type WorkerAdapter } from "../adapters/types.js";
import type { ExecutorDriver, Slot } from "../drivers/types.js";

export interface InteractiveSeedResult {
  output: string;
  seedFailed: boolean;
  seedError?: string;
  sessionId?: string;
  // v1.89 T19: whether THIS launch answered the adapter's declared trust modal. The daemon's
  // per-slot latch is initialized from it — a latch that starts false after the seed already
  // pressed Enter hands the next modal on that slot a free approval.
  trustAnswered: boolean;
}

// The workspace-trust prompt is a STARTUP gate: it renders before the readiness banner and blocks
// it, so this wait is the only window in which anything can answer it. Observation therefore runs
// for the WHOLE readiness budget. Review round 7 (material): a 60-second cutoff here was a window
// in which a real modal is simply never read — with a two-minute deadline and the modal at 61s the
// seed sent zero keys and failed on readiness. A cycle is a bounded readiness wait plus one pane
// read, so readiness still returns the instant it appears and the cadence only bounds how long a
// modal sits unanswered; the loop's total cost is one pane read per second of a launch that is
// blocked anyway, and it ends at the first of readiness, a modal, or the deadline.
const TRUST_POLL_MS = 1_000;
const TRUST_PANE_ROWS = 80;

type SeedDriver = Pick<ExecutorDriver, "run" | "waitOutput" | "read" | "sendKey">;

// v1.89 T19 / OBS-406: wait for readiness, answering a fingerprint-matched trust modal at most ONCE
// on the way. The daemon's own trust loop runs only after runInteractiveSeed returns, and this wait
// is exactly the window the modal blocks in — a declaration consulted only there is unreachable
// (kimi.ts states that gap at its own `trustDialog`).
async function awaitReadiness(opts: {
  driver: SeedDriver;
  slot: Slot;
  adapter: WorkerAdapter;
  readinessMatch: string;
  deadline: number;
  onTrustAnswered?: () => void;
}): Promise<{ ready: boolean; trustAnswered: boolean }> {
  const { driver, slot, readinessMatch, deadline } = opts;
  const dialog = opts.adapter.trustDialog;
  const left = () => Math.max(0, deadline - Date.now());
  // Nothing this launch could answer (no declaration, an honest {kind:"none"}, or a driver with no
  // keystroke surface): the single long wait, byte-identical to pre-T19 behaviour.
  if (!dialog || dialog.kind === "none" || !driver.sendKey) {
    return { ready: await driver.waitOutput(slot, readinessMatch, left()), trustAnswered: false };
  }
  let trustAnswered = false;
  while (!trustAnswered && left() > 0) {
    if (await driver.waitOutput(slot, readinessMatch, Math.min(TRUST_POLL_MS, left()))) {
      return { ready: true, trustAnswered };
    }
    let paneText: string;
    try {
      paneText = await driver.read(slot, TRUST_PANE_ROWS);
    } catch {
      continue; // a failed read is not a matched modal — keep observing, spend nothing
    }
    if (!matchesTrustDialog(paneText, dialog)) continue;
    // Review round 7 (material): the latch is spent BEFORE the awaited send, not after it. A send
    // that dispatches the key and THEN rejects is ambiguous — the keystroke may already be in the
    // slot — so a retry is a possible SECOND Enter landing on whatever modal is showing next, the
    // exact harm this contract exists to prevent. Ambiguity fails closed: one attempt per launch,
    // and the attempt (not the resolution) is what the daemon's per-slot latch inherits.
    trustAnswered = true;
    // Review round 8 (material): the RETURN VALUE is not the only path out of this function — the
    // seed-line delivery below it throws DeliveryReadinessError, and a daemon that learns of the
    // answer only from a result it never receives initializes its latch false with the key already
    // sent. So the answer is reported the instant it is spent, before anything that can throw.
    opts.onTrustAnswered?.();
    try {
      await driver.sendKey(slot, dialog.key);
    } catch {
      /* dispatched-then-rejected: never retried here, and never re-tried by the daemon either */
    }
  }
  return { ready: await driver.waitOutput(slot, readinessMatch, left()), trustAnswered };
}

// v1.69 T6: launch-then-seed handoff for adapters whose real TUI cannot be argv-seeded.
// Both the launch command and the seed line are delivered through the driver's existing `run`
// primitive (pane-run on herdr). After the seed line is injected we read the pane back and
// treat a seed that is still sitting in the input box as a hard failure (OBS-105 discipline).
export async function runInteractiveSeed(opts: {
  driver: SeedDriver;
  slot: Slot;
  adapter: WorkerAdapter;
  assignment: Assignment;
  promptFile: string;
  taskTimeoutMinutes: number;
  // Fired the instant the trust key is spent, so a caller keeping a per-slot latch learns of the
  // answer even when this call ends by THROWING (the seed-line delivery below can) rather than
  // returning. `trustAnswered` on the result carries the same fact for every returning path.
  onTrustAnswered?: () => void;
}): Promise<InteractiveSeedResult> {
  const seed = opts.adapter.interactiveSeed!;
  await opts.driver.run(opts.slot, seed.launch(opts.assignment.model));

  // `trustAnswered` rides EVERY return below, including both early ones: the daemon initializes its
  // per-slot latch from it, and an omission there reads as "no key was sent" — the second-Enter defect.
  const { ready, trustAnswered } = await awaitReadiness({
    driver: opts.driver,
    slot: opts.slot,
    adapter: opts.adapter,
    readinessMatch: seed.readinessMatch,
    deadline: Date.now() + opts.taskTimeoutMinutes * 60_000,
    ...(opts.onTrustAnswered ? { onTrustAnswered: opts.onTrustAnswered } : {}),
  });
  const banner = await opts.driver.read(opts.slot, 1000);
  if (!ready) {
    return { output: banner, seedFailed: true, seedError: `readiness pattern not seen: ${seed.readinessMatch}`, trustAnswered };
  }

  let sessionId: string | undefined;
  if (seed.confirmBanner) {
    const confirm = seed.confirmBanner(banner, opts.assignment.model);
    if (!confirm.ok) {
      return { output: banner, seedFailed: true, seedError: confirm.error, trustAnswered };
    }
    sessionId = confirm.sessionId;
  }

  const seedText = seed.seedLine(opts.promptFile);
  await opts.driver.run(opts.slot, seedText);

  let output = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    output = await opts.driver.read(opts.slot, 1000);
    const bottom = output.trimEnd().split("\n").pop() ?? "";
    if (!bottom.includes(seedText)) {
      return { output, seedFailed: false, trustAnswered, ...(sessionId ? { sessionId } : {}) };
    }
  }
  return { output, seedFailed: true, seedError: "seed line never left the input box", trustAnswered, ...(sessionId ? { sessionId } : {}) };
}
