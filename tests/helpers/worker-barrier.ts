// OBS-1163: fake-worker races used to be ordered by unequal `sleep`s, so a loaded host could land
// either worker first. A barrier holds a scripted worker's shell on a file that the test creates the
// moment the journal records the event the worker must wait for — dispatch, worker-result, merge or
// approval — and remembers which event released it, so the assertion can prove the ordering was
// event-driven rather than lucky. A barrier never released within its bound exits the worker with a
// named failure, so a missed release costs one bounded attempt, never a hung suite.
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { runDaemon, type RunSummary } from "../../src/run/daemon.js";
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
  // OBS-1189: a held worker must print a byte BEFORE it waits. The daemon's print loop declares a
  // pane that stays empty for EARLY_LAUNCH_LIVENESS_MS (60 s) after dispatch a dead channel — a real
  // rule for a real worker — and a barrier held past that window on a loaded host (the releasing task's
  // whole pipeline ran first) was concluded dead, its scripted retry spent, and the run closed with one
  // task delivered. The announcement makes the hold a live, silent-by-choice worker, not a dead one.
  const hold = `echo ${shq(`barrier ${name} held`)}; i=0; until test -e ${shq(path)}; do i=$((i+1)); if [ "$i" -ge ${polls} ]; then echo ${shq(`barrier ${name} never released`)} >&2; exit 1; fi; sleep ${BARRIER_POLL_S}; done`;
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
  if (on?.event !== event || on.taskId !== releasedBy) {
    // A file written with no journal row is a hand release; a missing file was never released.
    const how = on ? `${on.event} ${on.taskId ?? ""}`.trim() : b.released ? "hand" : "never";
    out.push(`${b.name} released by ${how}, not ${event} ${releasedBy}`);
  }
  const released = releaseIndex(rows, b);
  const result = rows.findLastIndex((e) => e.event === "worker-result" && e.taskId === held);
  if (released < 0 || result <= released) out.push(`${held} worker-result row ${result} is not after ${b.name}'s release row ${released}`);
  return out;
}

/** A task's last `n` journal rows, event plus truncated data: the diagnostic a missing commit must carry. */
export function lastRows(rows: JournalEvent[], taskId: string, n = 5): string[] {
  return rows.filter((e) => e.taskId === taskId).slice(-n).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 160)}`);
}

/**
 * OBS-1189: the Q-1 fixture's release schedules. `held`'s retry waits on `first`'s row — its merge
 * (delayed release: the held retry starts after the first commit landed, so merges are ordered) or its
 * consult-verdict (consult completion: both retries run beside each other, so merges land in either
 * order). Every schedule must still deliver BOTH distinct commits.
 */
export const Q1_SCHEDULES = [
  { on: "merge", ordered: true },
  { on: "task-done", ordered: true },
  { on: "consult-verdict", ordered: false },
] as const satisfies ReadonlyArray<{ on: string; ordered: boolean }>;
export type Q1Schedule = (typeof Q1_SCHEDULES)[number];

/**
 * Every Q-1 fact the run fails to prove (empty when it holds): both tasks done, the held retry after
 * its release row, no quota failover, both merges (in `first, held` order when the schedule orders
 * them) and both task files on the integration tip. A one-task summary names the missing task's last
 * five rows, so a loaded-host red carries the undelivered task's cause on the record.
 */
export function q1Violations(o: {
  runId: string; first: string; held: string; schedule: Q1Schedule; barrier: WorkerBarrier;
  done: string[]; rows: JournalEvent[]; tree: string;
}): string[] {
  const { runId, first, held, schedule, barrier, done, rows } = o;
  const out: string[] = [];
  for (const id of [first, held]) {
    if (!done.includes(id)) out.push(`${runId}: ${id} not done — last rows: ${lastRows(rows, id).join(" | ")}`);
    if (!o.tree.split("\n").includes(`${id}.txt`)) out.push(`${runId}: ${id}.txt missing from the integration tip — last rows: ${lastRows(rows, id).join(" | ")}`);
  }
  out.push(...heldAfterRelease(rows, barrier, held, schedule.on, first).map((v) => `${runId}: ${v}`));
  if (rows.some((e) => e.event === "quota-failover")) out.push(`${runId}: a quota-failover row (the dumps are consult retries, never failovers)`);
  const merges = rows.filter((e) => e.event === "merge").map((e) => e.taskId!);
  const expected = schedule.ordered ? [first, held] : [first, held].sort();
  if ((schedule.ordered ? merges : [...merges].sort()).join() !== expected.join()) out.push(`${runId}: merges [${merges}], expected ${schedule.ordered ? "" : "the set "}[${expected}]`);
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
  return { repo, fake, ...pair, violations };
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

// SHIP decision: NO-SHIP product cure. v2.6.8 T6 delivers the owned diagnostic only. The unidentified
// HYG-09 stall still waits in src/run; naming it here is not a claim that the wait is fixed.
/** Documented diagnostic deadline. Omitted input uses this. Zero, negative, non-integer and non-finite refuse. */
export const DIAGNOSTIC_DEADLINE_MS = 60_000;

export function diagnosticDeadlineMs(ms?: number): number {
  if (ms === undefined) return DIAGNOSTIC_DEADLINE_MS;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0) throw new Error(`diagnostic deadline refuses ${String(ms)}`);
  return ms;
}

const emit = (line: string) => { writeSync(1, `\n${line}\n`); };
type Id = "T1" | "T2";
const otherId = (id: Id): Id => (id === "T1" ? "T2" : "T1");

export interface BarrierRecord {
  name: string;
  released: boolean;
  releasedOn: JournalEvent | null;
}
export const barrierRecord = (b: WorkerBarrier): BarrierRecord => ({ name: b.name, released: b.released, releasedOn: b.releasedOn ?? null });
export function asBarrier(r: BarrierRecord): WorkerBarrier {
  return {
    name: r.name, path: "", hold: "",
    get released() { return r.released; },
    get releasedOn() { return r.releasedOn ?? undefined; },
    release() {},
  };
}

export interface OrderingProof {
  repo: string;
  runId: string;
  scenario: string;
  fixture: "hyg09" | "partial" | "resume" | "keep";
  first: Id;
  held: Id;
  deadlineMs: number;
  hand: boolean;
  barriers: BarrierRecord[];
  done: string[];
  human: string[];
  firstClose: string | null;
  workerSlot: Record<string, string | null>;
  closeCount: Record<string, number>;
  violations: string[];
}

/** Release / close / merge oracle for one retained journal. Empty when the member holds. */
export function orderingOracle(proof: OrderingProof, rows: JournalEvent[]): string[] {
  const { runId, first, held } = proof;
  const out: string[] = [];
  const sawLaunch = (id: string) => rows.some((e) => e.event === "worker-launch" && e.taskId === id);
  if (proof.fixture === "hyg09") {
    const b = asBarrier(proof.barriers[0]!);
    out.push(...heldAfterRelease(rows, b, held, "task-done", first).map((v) => `${runId}: ${v}`));
    if ([...proof.done].sort().join() !== "T1,T2") out.push(`${runId}: done [${proof.done}], expected [T1,T2]`);
    if (proof.firstClose !== proof.workerSlot[first]) out.push(`${runId}: first close ${proof.firstClose} is not ${first}'s slot ${proof.workerSlot[first]}`);
    for (const id of ["T1", "T2"] as const) {
      if (proof.closeCount[id] !== 1) out.push(`${runId}: ${id} closes ${proof.closeCount[id] ?? 0}`);
      if (!rows.some((e) => e.event === "task-done" && e.taskId === id)) out.push(`${runId}: journal missing task-done ${id}`);
      if (!sawLaunch(id)) out.push(`${runId}: journal missing worker-launch ${id}`);
    }
    return out;
  }
  const ready = asBarrier(proof.barriers[0]!);
  const loser = asBarrier(proof.barriers[1]!);
  out.push(...heldAfterRelease(rows, ready, first, "worker-launch", held).map((v) => `${runId}: ${v}`));
  out.push(...heldAfterRelease(rows, loser, held, "merge", first).map((v) => `${runId}: ${v}`));
  if (proof.done.join() !== first) out.push(`${runId}: done [${proof.done}], expected [${first}]`);
  if (proof.human.join() !== held) out.push(`${runId}: human [${proof.human}], expected [${held}]`);
  const merges = rows.filter((e) => e.event === "merge").map((e) => e.taskId);
  if (merges.join() !== first) out.push(`${runId}: merges [${merges}], expected [${first}]`);
  const at = (event: string, taskId: string) => rows.findIndex((e) => e.event === event && e.taskId === taskId);
  const mergeAt = at("merge", first);
  if (!(mergeAt >= 0 && mergeAt < at("merge-conflict", held))) out.push(`${runId}: no ${held} merge-conflict after ${first}'s merge`);
  if (!rows.some((e) => e.event === "consult-verdict" && e.taskId === held && e.data.action === "human")) out.push(`${runId}: no human consult verdict for ${held}`);
  if (!rows.some((e) => e.event === "task-human" && e.taskId === held)) out.push(`${runId}: journal missing task-human ${held}`);
  if (!rows.some((e) => e.event === "task-done" && e.taskId === first)) out.push(`${runId}: journal missing task-done ${first}`);
  if (!sawLaunch(first) || !sawLaunch(held)) out.push(`${runId}: journal missing a worker-launch`);
  return out;
}

export interface ScenarioWatch {
  /** Stop the unref'd timer and return. Never waits for it. True when it already fired. */
  cancel(): boolean;
  note(event: JournalEvent): void;
}

/**
 * Unref'd watchdog beside one scenario. On expiry it prints the run, the scenario, each task's last
 * rows and every barrier state, then the expiry line. Normal completion calls cancel and moves on.
 */
export function watchScenario(o: {
  ms?: number;
  armOn?: { event: string; taskId?: string };
  runId: string;
  scenario: string;
  tasks: readonly string[];
  barriers: readonly WorkerBarrier[];
  readRows: () => JournalEvent[];
  onExpire?: (diagnostic: string) => void;
}): ScenarioWatch {
  const ms = diagnosticDeadlineMs(o.ms);
  let fired = false;
  let stopped = false;
  let armed = !o.armOn;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    if (fired || stopped) return;
    fired = true;
    let rows: JournalEvent[] = [];
    try { rows = o.readRows(); } catch { /* the print still names the barriers and the missing rows */ }
    const lines = [
      `DIAGNOSTIC run=${o.runId} scenario=${o.scenario} deadline=${ms}`,
      ...o.barriers.map((b) => {
        const on = b.releasedOn ? ` on ${b.releasedOn.event} ${b.releasedOn.taskId ?? ""}`.trimEnd() : "";
        return `barrier ${b.name} ${b.released ? "released" : "held"}${on}`;
      }),
      ...o.tasks.flatMap((id) => {
        const launch = rows.findLast((e) => e.event === "worker-launch" && e.taskId === id);
        return [
          `task ${id} last: ${lastRows(rows, id).join(" | ") || "(none)"}`,
          launch ? `worker-launch ${id} ${JSON.stringify(launch.data).slice(0, 160)}` : `worker-launch ${id} absent`,
        ];
      }),
    ];
    const diagnostic = lines.join("\n");
    writeSync(1, `\n${diagnostic}\nDIAGNOSTIC_EXPIRED run=${o.runId} scenario=${o.scenario}\n`);
    o.onExpire?.(diagnostic);
  };
  const arm = () => {
    if (stopped || fired || armed) return;
    armed = true;
    if (ceiling) clearTimeout(ceiling);
    timer = setTimeout(fire, ms);
    timer.unref();
  };
  if (o.armOn) {
    ceiling = setTimeout(fire, DIAGNOSTIC_DEADLINE_MS);
    ceiling.unref();
  } else {
    timer = setTimeout(fire, ms);
    timer.unref();
  }
  return {
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (ceiling) clearTimeout(ceiling);
      return fired;
    },
    note(event) {
      if (!o.armOn || event.event !== o.armOn.event) return;
      if (o.armOn.taskId !== undefined && event.taskId !== o.armOn.taskId) return;
      arm();
    },
  };
}

export const ORDERING_MEMBERS = [
  { fixture: "hyg09", first: "T1" },
  { fixture: "hyg09", first: "T2" },
  { fixture: "partial", first: "T1" },
  { fixture: "partial", first: "T2" },
  { fixture: "resume", first: "T1" },
  { fixture: "resume", first: "T2" },
  { fixture: "keep", first: "T1" },
  { fixture: "keep", first: "T2" },
] as const satisfies ReadonlyArray<{ fixture: OrderingProof["fixture"]; first: Id }>;

export type OrderingMember = { fixture: OrderingProof["fixture"]; first: Id; hand?: boolean; diagnosticMs?: number };
export type FixtureChildSpec =
  | ({ kind: "ordering" } & OrderingMember)
  | { kind: "healthy" }
  | { kind: "never-released"; diagnosticMs: number }
  | { kind: "hold-after-human" };

function closeProof(ops: { kind: string; name: string }[]): Pick<OrderingProof, "firstClose" | "workerSlot" | "closeCount"> {
  const worker = (id: string) => ops.find((op) => op.kind === "slot" && op.name.includes(`${id}-worker-fake-a0-`))?.name ?? null;
  const workerSlot = { T1: worker("T1"), T2: worker("T2") };
  const closeCount: Record<string, number> = {};
  for (const id of ["T1", "T2"]) {
    const name = workerSlot[id as Id];
    closeCount[id] = name ? ops.filter((op) => op.kind === "close" && op.name === name).length : 0;
  }
  return {
    firstClose: ops.find((op) => op.kind === "close" && /-worker-fake-a0-/.test(op.name))?.name ?? null,
    workerSlot, closeCount,
  };
}

function orderedDriver(): { driver: ExecutorDriver; ops: { kind: string; name: string }[] } {
  const inner = new SubprocessDriver();
  const ops: { kind: string; name: string }[] = [];
  return {
    ops,
    driver: {
      id: "ordered", interactive: false,
      status: inner.status.bind(inner), run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner), read: inner.read.bind(inner), notify: inner.notify.bind(inner),
      worktree: inner.worktree.bind(inner),
      async slot(cwd: string, name: string) { ops.push({ kind: "slot", name }); return inner.slot(cwd, name); },
      async close(s: Slot) { ops.push({ kind: "close", name: s.name }); return inner.close(s); },
    },
  };
}

/** Run production runDaemon under the watchdog, then leave the journal and the proof on disk. */
async function watchedDaemon(o: {
  repo: string; runId: string; scenario: string; fixture: OrderingProof["fixture"]; first: Id; held: Id;
  deadlineMs: number; hand: boolean; barriers: WorkerBarrier[];
  /** Slot/close log mutated by the driver while `run` is in flight. Read after the run returns. */
  closeOps?: { kind: string; name: string }[];
  run: (narrate: Narrate) => Promise<RunSummary>;
}): Promise<void> {
  let expiredText = "";
  let resolveExpired = () => {};
  const expired = new Promise<void>((resolve) => { resolveExpired = resolve; });
  const watch = watchScenario({
    ms: o.deadlineMs, runId: o.runId, scenario: o.scenario, tasks: ["T1", "T2"], barriers: o.barriers,
    readRows: () => { try { return Journal.open(o.repo, o.runId).read(); } catch { return []; } },
    onExpire: (text) => { expiredText = text; resolveExpired(); },
  });
  let summary: RunSummary | undefined;
  let error: string | undefined;
  try {
    const raced = await Promise.race([
      o.run((e) => watch.note(e)).then((s) => ({ kind: "done" as const, s })),
      expired.then(() => ({ kind: "expired" as const })),
    ]);
    if (raced.kind === "done") summary = raced.s;
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  }
  const fired = watch.cancel();
  if (!fired) emit(`WATCHDOG_CANCELLED run=${o.runId} scenario=${o.scenario}`);
  const barriers = o.barriers.map(barrierRecord);
  releaseAll(...o.barriers);
  let rows: JournalEvent[] = [];
  try { rows = Journal.open(o.repo, o.runId).read(); } catch (e) { error ??= e instanceof Error ? e.message : String(e); }
  const proof: OrderingProof = {
    repo: o.repo, runId: o.runId, scenario: o.scenario, fixture: o.fixture, first: o.first, held: o.held,
    deadlineMs: o.deadlineMs, hand: o.hand, barriers,
    done: summary?.done ?? [], human: summary?.human ?? [],
    ...(o.closeOps ? closeProof(o.closeOps) : { firstClose: null, workerSlot: { T1: null, T2: null }, closeCount: {} }),
    violations: [],
  };
  proof.violations = [
    ...(error ? [`${o.runId}: ${error}`] : []),
    ...(fired ? [`${o.runId}: diagnostic deadline ${o.deadlineMs} ms exhausted — ${expiredText.slice(0, 500)}`] : []),
    ...orderingOracle(proof, rows),
  ];
  const proofPath = join(o.repo, ".tickmarkr", "runs", o.runId, "ordering-proof.json");
  try {
    writeFileSync(proofPath, JSON.stringify(proof));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    emit(`OUTCOME ${JSON.stringify({ repo: o.repo, runId: o.runId, error: detail })}`);
    return;
  }
  emit(`OUTCOME ${JSON.stringify({ repo: o.repo, runId: o.runId, proofPath })}`);
}

async function runHyg(member: OrderingMember, scenario: string): Promise<void> {
  const first = member.first;
  const held = otherId(first);
  const runId = `run-owned-${scenario}`;
  const deadlineMs = diagnosticDeadlineMs(member.diagnosticMs);
  const barrier = workerBarrier(`${runId}-${held}`);
  if (member.hand) barrier.release();
  const { repo, fake } = setupRepo([T("T1"), T("T2")], { tasks: {
    [first]: [{ shell: `echo ${first} > ${first}.txt && ${COMMIT} ${first}`, result: { ok: true, summary: first } }],
    [held]: [{ shell: `${barrier.hold} && echo ${held} > ${held}.txt && ${COMMIT} ${held}`, result: { ok: true, summary: held } }],
  } }, "visibility:\n  keepPanes: run\n");
  const { driver, ops } = orderedDriver();
  await watchedDaemon({
    repo, runId, scenario, fixture: "hyg09", first, held, deadlineMs, hand: member.hand === true,
    barriers: [barrier], closeOps: ops,
    run: (note) => runDaemon(repo, {
      adapters: [fake], runId, driver, concurrency: 2,
      narrate: member.hand ? note : releaseOn(barrier, "task-done", first, note),
    }),
  });
}

async function runConflict(member: OrderingMember, scenario: string): Promise<void> {
  const first = member.first;
  const held = otherId(first);
  const runId = `run-owned-${scenario}`;
  const deadlineMs = diagnosticDeadlineMs(member.diagnosticMs);
  const pair = conflictPair(runId, first, held);
  if (member.hand) releaseAll(pair.ready, pair.loser);
  await watchedDaemon({
    repo: pair.repo, runId, scenario, fixture: member.fixture, first, held, deadlineMs, hand: member.hand === true,
    barriers: [pair.ready, pair.loser],
    run: (note) => runDaemon(pair.repo, { adapters: [pair.fake], runId, narrate: member.hand ? note : pair.narrate(note) }),
  });
}

async function neverReleased(diagnosticMs: number): Promise<void> {
  const deadlineMs = diagnosticDeadlineMs(diagnosticMs);
  const runId = "run-never-released";
  const scenario = "never-released";
  const ready = workerBarrier(`${runId}-ready`);
  const loser = workerBarrier(`${runId}-loser`);
  const { repo, fake } = setupRepo([T("T1"), T("T2")], { tasks: {
    T1: [{ shell: `${ready.hold} && echo T1 > T1.txt && ${COMMIT} T1`, result: { ok: true, summary: "T1" } }],
    T2: [{ shell: `${loser.hold} && echo T2 > T2.txt && ${COMMIT} T2`, result: { ok: true, summary: "T2" } }],
  } });
  emit(`REPO ${repo}`);
  const watch = watchScenario({
    ms: deadlineMs, armOn: { event: "worker-launch", taskId: "T1" },
    runId, scenario, tasks: ["T1", "T2"], barriers: [ready, loser],
    readRows: () => { try { return Journal.open(repo, runId).read(); } catch { return []; } },
  });
  await runDaemon(repo, { adapters: [fake], runId, concurrency: 2, narrate: (e) => watch.note(e) });
  watch.cancel();
}

async function holdAfterHuman(): Promise<void> {
  const runId = "run-hold-human";
  const scenario = "hold-after-human";
  const pair = conflictPair(runId, "T1", "T2");
  const post = workerBarrier(`${runId}-post`);
  emit(`REPO ${pair.repo}`);
  emit(`JOURNAL ${join(pair.repo, ".tickmarkr", "runs", runId, "journal.jsonl")}`);
  for (const barrier of [pair.ready, pair.loser, post]) emit(`BARRIER ${barrier.path}`);
  const watch = watchScenario({
    runId, scenario, tasks: ["T1", "T2"], barriers: [pair.ready, pair.loser, post],
    readRows: () => { try { return Journal.open(pair.repo, runId).read(); } catch { return []; } },
  });
  void runDaemon(pair.repo, {
    adapters: [pair.fake], runId,
    narrate: pair.narrate((e) => {
      watch.note(e);
      if (e.event !== "task-human") return;
      watch.cancel();
      emit(`WATCHDOG_CANCELLED run=${runId} scenario=${scenario}`);
      emit(`TASK-HUMAN ${e.taskId ?? ""}`);
    }),
  }).catch(() => {});
  await new Promise(() => {});
}

/** Owned-child entry: production runDaemon for one diagnostic-table scenario. Parking modes never return. */
export async function fixtureChild(spec: FixtureChildSpec): Promise<void> {
  if (spec.kind === "never-released") return neverReleased(spec.diagnosticMs);
  if (spec.kind === "hold-after-human") return holdAfterHuman();
  if (spec.kind === "healthy") return runHyg({ fixture: "hyg09", first: "T1" }, "healthy-ordered");
  const scenario = spec.hand ? `${spec.fixture}-${spec.first}-hand` : `${spec.fixture}-${spec.first}`;
  if (spec.fixture === "hyg09") return runHyg(spec, scenario);
  return runConflict(spec, scenario);
}
