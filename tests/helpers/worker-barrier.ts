// OBS-1163: fake-worker races used to be ordered by unequal `sleep`s, so a loaded host could land
// either worker first. A barrier holds a scripted worker's shell on a file that the test creates the
// moment the journal records the event the worker must wait for — dispatch, worker-result, merge or
// approval — and remembers which event released it, so the assertion can prove the ordering was
// event-driven rather than lucky. A barrier never released within its bound exits the worker with a
// named failure, so a missed release costs one bounded attempt, never a hung suite.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../../src/adapters/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "./tmprepo.js";

type Narrate = (event: JournalEvent) => void;

export interface WorkerBarrier {
  readonly name: string;
  readonly path: string;
  /** Shell prefix for a scripted step: `${b.hold} && <work>` blocks until `release` or the bound. */
  readonly hold: string;
  /** The journal event that released this barrier, undefined while held or when released by hand. */
  readonly releasedOn: JournalEvent | undefined;
  readonly released: boolean;
  release(on?: JournalEvent): void;
}

const BARRIER_POLL_S = 0.02;

/**
 * A held worker that never sees its release fails within `boundMs` instead of hanging. The default
 * (120 s) outlasts the releasing task's whole worker → gates → judge ‖ review → merge pipeline on a
 * loaded host: D-453's HYG-09 red at load1 14.8 was a 30 s bound expiring before the sibling's
 * task-done row, which parked the held task as if the ordering itself had failed.
 */
export function workerBarrier(name: string, boundMs = 120_000): WorkerBarrier {
  const path = join(makeTestTempDir("tickmarkr-barrier-"), `${name}.released`);
  const polls = Math.ceil(boundMs / (BARRIER_POLL_S * 1000));
  const hold = `i=0; until test -e ${shq(path)}; do i=$((i+1)); if [ "$i" -ge ${polls} ]; then echo ${shq(`barrier ${name} never released`)} >&2; exit 1; fi; sleep ${BARRIER_POLL_S}; done`;
  let releasedOn: JournalEvent | undefined;
  return {
    name, path, hold,
    get releasedOn() { return releasedOn; },
    get released() { return existsSync(path); },
    release(on?: JournalEvent) {
      if (existsSync(path)) return;
      releasedOn = on;
      writeFileSync(path, on ? `${on.event} ${on.taskId ?? ""}` : "manual");
    },
  };
}

/** A narrate sink that releases `barrier` on the first journal row matching `event` (and `taskId`). */
export function releaseOn(barrier: WorkerBarrier, event: string, taskId?: string, inner?: Narrate): Narrate {
  return (e) => {
    inner?.(e);
    if (e.event === event && (taskId === undefined || e.taskId === taskId)) barrier.release(e);
  };
}

/** A narrate sink that releases `barrier` on the row completing the set of every listed (event, taskId). */
export function releaseOnAll(barrier: WorkerBarrier, rows: ReadonlyArray<readonly [event: string, taskId: string]>, inner?: Narrate): Narrate {
  const pending = new Set(rows.map(([event, taskId]) => `${event} ${taskId}`));
  return (e) => {
    inner?.(e);
    if (pending.delete(`${e.event} ${e.taskId}`) && pending.size === 0) barrier.release(e);
  };
}

/** Index of `barrier.releasedOn` in the journal, so a test can prove the held worker finished after it. */
export function releaseIndex(events: JournalEvent[], barrier: WorkerBarrier): number {
  const on = barrier.releasedOn;
  if (!on) return -1;
  return events.findIndex((e) => e.ts === on.ts && e.event === on.event && e.taskId === on.taskId);
}

/** Release every barrier still held — the finally-clause cleanup, never an ordering tool. */
export function releaseAll(...barriers: WorkerBarrier[]): void {
  for (const b of barriers) b.release();
}

/**
 * Every ordering fact the journal fails to prove (empty when it holds): `b` was released by
 * `releasedBy`'s `event` row, and `held`'s LAST worker-result lands after that row — a retrying task
 * (Q-1) records its failed attempt before the held one. An early release has no row, so it is red.
 */
export function heldAfterRelease(rows: JournalEvent[], b: WorkerBarrier, held: string, event: string, releasedBy: string): string[] {
  const out: string[] = [];
  const on = b.releasedOn;
  if (on?.event !== event || on.taskId !== releasedBy) out.push(`${b.name} released by ${on ? `${on.event} ${on.taskId}` : "hand or never"}, not ${event} ${releasedBy}`);
  const released = releaseIndex(rows, b);
  const result = rows.findLastIndex((e) => e.event === "worker-result" && e.taskId === held);
  if (released < 0 || result <= released) out.push(`${held} worker-result row ${result} is not after ${b.name}'s release row ${released}`);
  return out;
}

/**
 * OBS-1163 same-base handshake for a conflicting pair: `held` waits for `first`'s merge row, and
 * `first` waits for `held`'s worker-launch row. The daemon captures a task's base and builds its
 * worktree before that worker launches, so `held` provably starts on the pre-merge tip — the pair
 * conflicts on ONE base by construction, never because `held` happened to dispatch before the merge.
 */
export function sameBasePair(tag: string, first: string, held: string) {
  const ready = workerBarrier(`${tag}-${first}-ready`);
  const loser = workerBarrier(`${tag}-${held}`);
  return {
    first, held, ready, loser,
    narrate: (inner?: Narrate) => releaseOn(loser, "merge", first, releaseOn(ready, "worker-launch", held, inner)),
    release: () => releaseAll(ready, loser),
    violations: (rows: JournalEvent[]) => [
      ...heldAfterRelease(rows, ready, first, "worker-launch", held),
      ...heldAfterRelease(rows, loser, held, "merge", first),
    ],
  };
}

/** Two workers writing shared.txt on one base: `first` merges, `held` meets the conflict and parks. */
export function conflictPair(runId: string, first: string, held: string) {
  const pair = sameBasePair(runId, first, held);
  const shell = (id: string) => `echo ${id} > shared.txt && ${COMMIT} ${id}`;
  const { repo, fake } = setupRepo([T("T1"), T("T2")], {
    consult: { action: "human", notes: "conflicting edits need a person" },
    tasks: {
      [first]: [{ shell: `${pair.ready.hold} && ${shell(first)}`, result: { ok: true, summary: first } }],
      [held]: [{ shell: `${pair.loser.hold} && ${shell(held)}`, result: { ok: true, summary: held } }],
    },
  });
  /** Runs the production daemon and returns every violated fact — empty when the pair conflicted in order. */
  const violations = async (): Promise<string[]> => {
    const s = await runDaemon(repo, { adapters: [fake], runId, narrate: pair.narrate() }).finally(pair.release);
    const rows = Journal.open(repo, runId).read();
    const at = (event: string, taskId: string) => rows.findIndex((e) => e.event === event && e.taskId === taskId);
    const merges = rows.filter((e) => e.event === "merge").map((e) => e.taskId);
    return [
      ...pair.violations(rows),
      ...(s.done.join() === first ? [] : [`${runId}: done [${s.done}], expected [${first}]`]),
      ...(s.human.join() === held ? [] : [`${runId}: human [${s.human}], expected [${held}]`]),
      ...(merges.join() === first ? [] : [`${runId}: merges [${merges}], expected [${first}]`]),
      ...(at("merge", first) < at("merge-conflict", held) ? [] : [`${runId}: no ${held} merge-conflict after ${first}'s merge`]),
      ...(rows.some((e) => e.event === "consult-verdict" && e.taskId === held && e.data.action === "human") ? [] : [`${runId}: no human consult verdict for ${held}`]),
    ];
  };
  return { repo, ...pair, violations };
}

/**
 * The stress harness's child-process entry (tests/run/daemon/fixture-ordering.test.ts): one fixture per
 * owned node process. "pair" runs a conflict pair; "hang" holds a lone worker for ten minutes so the
 * harness's wall-time bound — not the fixture — ends it. Every worker-launch row is printed, so the
 * harness can arm its bound on a worker that is known to be live.
 */
export async function fixtureViolations(mode: "pair" | "hang", runId: string, first: string): Promise<string[]> {
  if (mode === "pair") return conflictPair(runId, first, first === "T1" ? "T2" : "T1").violations();
  const never = workerBarrier(`${runId}-never`, 600_000);
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: never.hold, result: { ok: true, summary: "held" } }] } });
  const launched: Narrate = (e) => { if (e.event === "worker-launch") process.stdout.write(`\nLAUNCHED ${e.taskId}\n`); };
  await runDaemon(repo, { adapters: [fake], runId, narrate: launched });
  return [`${runId}: the hang fixture settled on its own — its worker was never cut at the bound`];
}
