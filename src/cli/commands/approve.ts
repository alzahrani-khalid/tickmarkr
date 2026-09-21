import { graphDefinitionHash, loadGraph, saveGraph, taskDefinitionFingerprint } from "../../graph/graph.js";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { loadConfig } from "../../config/config.js";
import { integrationBranch } from "../../run/merge.js";
import { separabilityErrors } from "../../compile/collateral.js";
import { GATE_NAMES } from "../../graph/schema.js";
import { applyScopeAmendments, engagementComparable, engagementReleased, ATTEMPT_CAP_RELEASE, GATE_SATISFIED_RELEASE, Journal, RECHECK_RELEASE, REVIEW_UPHELD_RELEASE, type JournalEvent } from "../../run/journal.js";

export const APPROVAL_DISPOSITIONS = ["dispatch", "waive-gate", "re-dispatch", "fund-fixed-attempt", "fresh-budget"] as const;
export type ApprovalDisposition = (typeof APPROVAL_DISPOSITIONS)[number];

/**
 * What each disposition's release actually buys — the clause every operator-facing sentence about
 * this approval ends on. One table, because two surfaces say it: this command's own message, and the
 * setup cockpit's pre-write confirm inset, which predicts the effect BEFORE the write. A prediction
 * that can drift from the write is worth less than none, so neither surface writes the phrase itself.
 */
export const APPROVAL_ENACTS: Record<ApprovalDisposition, string> = {
  dispatch: "dispatch it",
  "waive-gate": "continue past the approved gate",
  "re-dispatch": "re-dispatch against the full gate suite only if re-running the whole declared battery on the parked commit before any worker is red",
  "fund-fixed-attempt": "dispatch a fixed attempt carrying the findings",
  "fresh-budget": "dispatch it on a fresh attempt budget",
};

export function approvalDispositionForRelease(release: unknown): ApprovalDisposition {
  if (release === GATE_SATISFIED_RELEASE) return "waive-gate";
  if (release === RECHECK_RELEASE) return "re-dispatch";
  if (release === REVIEW_UPHELD_RELEASE) return "fund-fixed-attempt";
  if (release === ATTEMPT_CAP_RELEASE) return "fresh-budget";
  return "dispatch";
}
import { acquireApprovalSerialization, runLockOwner } from "../../run/lock.js";

/** The closed verb set every decision surface may name. Nothing outside it reaches this command. */
export const DECISION_VERBS = ["approve", "waive", "uphold", "recheck"] as const;
export type DecisionVerb = (typeof DECISION_VERBS)[number];

/** The newest park a decision binds to, read the one way this command reads it. */
export interface NewestPark {
  /** Index into the journal's event array; `line` is the physical 1-based journal line. */
  index: number;
  line: number;
  ts: string | undefined;
  /** The daemon-recorded kind (task-human data.kind), never inferred from prose. */
  kind: string | undefined;
  reason: string | undefined;
  approveCommand?: string;
  /** The newest failed gate before the park — the gate a waive would satisfy. */
  failedGate: string | undefined;
  /** A pre-dispatch human gate whose reason marks it permanent by design (see isTombstonePark). */
  tombstone: boolean;
}

/**
 * There is no closed park kind for a declaration-shaped retirement, so the evidence is the one the
 * daemon recorded: a pre-dispatch human-gate park whose reason carries the task's own title, where the
 * spec declares the tombstone. Read narrowly on purpose — every other kind is actionable regardless of prose.
 */
export function isTombstonePark(kind: string | undefined, reason: string | undefined): boolean {
  // Declaration retirements use an explicit title marker: either an em-dash-delimited
  // `— tombstone` suffix or the canonical `tombstone, never dispatched` phrase. A task title
  // that merely discusses tombstones is still an ordinary, actionable human gate.
  return kind === "human-gate"
    && /(?:\s—\s+tombstone\b|\btombstone,\s*never dispatched\b)/iu.test(reason ?? "");
}

export function newestPark(
  events: readonly JournalEvent[],
  taskId: string,
  /** Physical zero-based source indexes corresponding one-for-one with `events`. */
  sourceIndexes?: readonly number[],
): NewestPark | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event !== "task-human" || e.taskId !== taskId) continue;
    const kind = typeof e.data.kind === "string" ? e.data.kind : undefined;
    const reason = typeof e.data.reason === "string" ? e.data.reason : undefined;
    return {
      index: i, line: (sourceIndexes?.[i] ?? i) + 1, ts: typeof e.ts === "string" ? e.ts : undefined, kind, reason,
      approveCommand: typeof e.data.approveCommand === "string" ? e.data.approveCommand : undefined,
      failedGate: failedGateForNewestPark(events, taskId, i), tombstone: isTombstonePark(kind, reason),
    };
  }
  return undefined;
}

/** Parsed events paired with their immutable physical JSONL identities. */
export function readJournalEvents(journal: Journal): { events: JournalEvent[]; sourceIndexes: number[] } {
  const tracked = journal.readTracked();
  return {
    events: tracked.map((row) => row.raw as JournalEvent),
    sourceIndexes: tracked.map((row) => row.sourceIndex),
  };
}

/**
 * FINAL §3.3's decision menu as data: human-gate/attempt-cap/other non-gate parks → approve; infra →
 * approve or recheck; review gate-fail → waive/uphold/recheck; other gate-fail → waive/recheck; a
 * gate-fail park with no failed-gate evidence, or a tombstone → nothing (a diagnostic, never a
 * fabricated verb). The refusals in `approve` below enforce the same table; this is the one place a
 * surface may read it from, so what a menu offers and what the command accepts cannot drift.
 */
export function permittedDecisionVerbs(park: Pick<NewestPark, "kind" | "failedGate" | "tombstone"> | undefined): readonly DecisionVerb[] {
  if (!park || park.tombstone || park.kind === "scope-request") return [];
  if (park.kind === "gate-fail") {
    if (park.failedGate === undefined) return [];
    return park.failedGate === "review" ? ["waive", "uphold", "recheck"] : ["waive", "recheck"];
  }
  if (park.kind === "infra") return ["approve", "recheck"];
  if (park.kind === "diff-cap") return ["recheck"]; // OBS-1007: a cap trip is re-gated under a raised cap, never re-bought
  return ["approve"];
}

/** The release marker this command appends for a verb on a park — the fact a read-back must match. */
export function releaseForDecision(verb: DecisionVerb, park: Pick<NewestPark, "kind" | "failedGate">): string | undefined {
  if (verb === "waive") return GATE_SATISFIED_RELEASE;
  if (verb === "uphold") return REVIEW_UPHELD_RELEASE;
  if (verb === "recheck") return RECHECK_RELEASE;
  return park.kind === ATTEMPT_CAP_RELEASE ? ATTEMPT_CAP_RELEASE : undefined;
}

// GATE-08 (v1.12): approve a parked human gate so the run dispatches it — the live daemon owning this
// run enacts the release at its next task boundary (v2.2 T3); with no live repository owner the next
// `tickmarkr resume <runId>` enacts it, while a different live run must end before this run resumes.
//
// The approval is a JOURNAL EVENT (task-approved) carrying who and when — it touches ONLY the
// append-only journal. Writing it into tickmarkr's compiled graph artifact would be silently erased by
// the next recompile (which re-emits humanGate:true from the plan frontmatter) — Phase 42 D-02.
//
// v1.24 OBS-18: when the park kind is attempt-cap (not a humanGate pre-dispatch park), the event
// also carries `release: "attempt-cap"`. replayResumeState zeros the attempt budget on that marker so
// resume dispatches instead of re-parking in the same tick; tried-list is preserved. Unknown kinds
// receive no release and remain fail-closed to a human rather than being inferred from prose.
//
// Fail-closed (D-05): unknown runId, unknown taskId, a not-parked task, and a double-approve are all
// LOUD refusals that name the reason and append NO event — never a silent no-op. A handler throw
// becomes `tickmarkr approve: <message>` at exit 1 (src/cli/index.ts dispatch).
//
// Who/when is truthful, not dressed-up auth (D-03): default actor os.userInfo().username; --by overrides
// for delegated approval; optional --reason; the event's ts (stamped by Journal.append) is the when.
// OBS-189/OBS-567: gate-fail parks require a named decision. `--waive` accepts the rejected
// diff (gate-satisfied); plain approve refuses instead of silently waiving; `--uphold` sides WITH
// the reviewer and funds ONE fixed worker attempt carrying the findings — the park costs an attempt,
// never the run.
//
// T14, amended by v2.2 T3: the runtime ACCEPTS an approval against a live daemon exactly as against a
// finished run, and the live daemon now SWEEPS accepted approvals at every task boundary — so the
// owner of this run enacts the decision itself, and the approval is no longer inert for that run.
// Every approval still closes on a DISPOSITION drawn from the five-token vocabulary printed in a JSON
// status line — `deferred-live` keeps its established machine token, and only its TEXT changes — but
// the ENACTMENT half of each message is now chosen from the repository lock's three states. This
// run's live daemon names its boundary sweep; no live owner names `tickmarkr resume <runId>`; and a
// different live run names the lock holder and waits for a resume after that run ends without
// prescribing a command that would contend for its lock.
// Approvals during tip verify cancel that verify and return to dispatch. The completion record
// still names decisions that never reached enactment as `approvalDisposition: "outstanding"`.
// Liveness and the enactment sentence are both stated once, below (ownedByLiveDaemon /
// approvalEnactment), because the setup cockpit predicts the same effect before writing and a
// prediction free to drift from the write is worth less than none.
//
export type ApprovalStatus = "deferred-live" | "recorded-no-owner";

/** The requested run plus the different live run currently blocking its repository, when present. */
export interface ApprovalRunOwner {
  runId: string;
  live: boolean;
  blockingRunId?: string;
}

// THE liveness rule, written once. The lock is REPOSITORY-wide, so a live owner of some OTHER run is
// not an owner of this one and sweeps none of its approvals — claiming otherwise is the same
// falsehood in a new shape. Liveness itself comes from lock.ts's runLockOwner (the same inspect() the
// acquire/unlock decision table uses), never a second `process.kill(pid, 0)`, and never the lock
// FILE's presence: a stale lock whose recorded pid is dead is not a live run.
const ownedByLiveDaemon = (owner: { runId?: string; live: boolean } | undefined, runId: string): ApprovalRunOwner => {
  const run: ApprovalRunOwner = { runId, live: owner?.live === true && owner.runId === runId };
  if (owner?.live === true && owner.runId !== undefined && owner.runId !== runId) {
    // Preserve the shipped enumerable { runId, live } shape while carrying the third state.
    Object.defineProperty(run, "blockingRunId", { value: owner.runId });
  }
  return run;
};

/** The same read `approve` performs, for surfaces that must predict an enactment before writing. */
export function approvalRunOwner(cwd: string, runId: string): ApprovalRunOwner {
  return ownedByLiveDaemon(runLockOwner(cwd), runId);
}

/** The one sentence that says who enacts this release and what it buys. */
export function approvalEnactment(token: ApprovalDisposition, run: ApprovalRunOwner): string {
  if (run.live) {
    return `the live daemon enacts this at its next task boundary — it will ${APPROVAL_ENACTS[token]}, including in the approval window or by cancelling an in-progress tip verify`;
  }
  if (run.blockingRunId) {
    return `release recorded; live run \`${run.blockingRunId}\` holds the repository lock, so resume \`${run.runId}\` after it ends to ${APPROVAL_ENACTS[token]}`;
  }
  return `run \`tickmarkr resume ${run.runId}\` to ${APPROVAL_ENACTS[token]}`;
}

/** The production command registered in COMMANDS; its returned bytes are what the CLI prints. */
export async function approve(argv: string[], cwd = process.cwd()): Promise<string> {
  const { runId, taskId, by, reason, waive, uphold, recheck, reviewRoundCeiling, files } = parseArgs(argv);
  const decisions = [waive, uphold, recheck].filter(Boolean).length;
  if (decisions > 1) throw new Error("--waive, --uphold and --recheck are different decisions — pass one");
  const serialization = await acquireApprovalSerialization(cwd, runId);

  try {
  // Journal.open throws `no journal for <runId> at <dir>` on an unknown run — that IS the refusal.
  const journal = Journal.open(cwd, runId);

  const status = journal.replayStatuses().get(taskId);
  if (status === undefined) {
    throw new Error(`task ${taskId} has no events in run ${runId} — unknown task or never dispatched`);
  }
  // OBS-1022: a task-failed task whose preserved ref (or task branch) carries commits ahead of the
  // integration base owns verified-able work; --recheck re-gates that tree with no worker. Any other
  // verb on a failed task, or a recheck over nothing landed, is refused naming why.
  if (status === "failed" && recheck) {
    const ahead = failedTaskCommitsAhead(cwd, journal, runId, taskId);
    if (ahead.count === 0) {
      throw new Error(`task ${taskId} is failed and ${ahead.ref} carries no commits ahead of ${ahead.base} — nothing to re-gate; use resume --retry-failed to fund a worker`);
    }
    journal.append("task-approved", taskId, {
      by, ...(reason ? { reason } : {}), via: "cli", release: RECHECK_RELEASE,
      recheckedRef: ahead.ref, commitsAhead: ahead.count,
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    });
    return disposition(cwd, runId, "re-dispatch", `re-checking failed ${taskId} in ${runId} — by ${by}; ${ahead.count} commit(s) on ${ahead.ref} ahead of ${ahead.base}; no worker funded`, serialization.contended);
  }
  if (status !== "human") {
    // a silent no-op would be worse than a loud refusal — name the actual status (D-05)
    throw new Error(`task ${taskId} is ${status}, not a parked human gate — refusing (a silent no-op would be worse)`);
  }

  // OBS-18: only the most recent task-human for this task decides whether this approval grants a
  // fresh attempt budget. The closed daemon-issued kind, never a human prose string, controls release.
  const { events, sourceIndexes } = readJournalEvents(journal);
  const park = newestPark(events, taskId, sourceIndexes);
  const lastHuman = park === undefined ? undefined : events[park.index];
  const capPark = park?.kind === ATTEMPT_CAP_RELEASE;
  const gateFailPark = park?.kind === "gate-fail";
  const infraPark = park?.kind === "infra" || park?.kind === "diff-cap";
  const failedGate = gateFailPark ? park?.failedGate : undefined;
  if ((park?.kind === "scope-request" && !decisions) || files !== undefined) {
    if (park?.kind !== "scope-request") throw new Error("--files requires a scope-request park");
    if (!files?.length) throw new Error(`scope-request for ${taskId} requires --files <glob,…>`);
    if (decisions) throw new Error("--files cannot be combined with --waive, --uphold or --recheck");
    const graph = applyScopeAmendments(loadGraph(cwd), journal, false, engagementReleased(events));
    const from = graphDefinitionHash(graph);
    if (!engagementComparable(journal.read(), from).comparable
        || (lastHuman?.data.graphDefinitionHash !== undefined && lastHuman.data.graphDefinitionHash !== from)) {
      throw new Error(`refusing stale scope-request approval for ${taskId}: graph revision changed`);
    }
    const task = graph.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const amendedFiles = [...new Set([...task.files, ...files])];
    if (amendedFiles.length === task.files.length) throw new Error("--files must extend the parked files[] revision");
    const amended = { ...graph, tasks: graph.tasks.map((t) => t.id === taskId ? { ...t, files: amendedFiles } : t) };
    const conflicts = separabilityErrors(amended.tasks);
    if (conflicts.length) throw new Error(`refusing scope-request approval for ${taskId}: ${conflicts.join("\n")}`);
    journal.append("task-approved", taskId, {
      by, ...(reason ? { reason } : {}), via: "cli", release: "scope-request",
      amendment: { from, to: graphDefinitionHash(amended), beforeFiles: task.files, files: amendedFiles, parkLine: park.line, definition: taskDefinitionFingerprint(task) },
    });
    // Do not write graph.json from this process while the daemon owns it: its sweep materializes
    // the amendment without replacing a sibling's running state with this command's snapshot.
    const projected = applyScopeAmendments(graph, journal, false, engagementReleased(events));
    const owner = approvalRunOwner(cwd, runId);
    if (!owner.live && !owner.blockingRunId) saveGraph(cwd, projected);
    return disposition(cwd, runId, "dispatch", `approved files[] for ${taskId} in ${runId} — by ${by}`, serialization.contended);
  }

  if (gateFailPark && !failedGate) {
    throw new Error(`task ${taskId} is parked on gate-fail but has no failed gate result on the newest park — refusing to infer one`);
  }

  if (uphold) {
    if (!gateFailPark || failedGate !== "review") {
      throw new Error(`--uphold applies to a review gate-fail park; ${taskId}'s newest park is ${String(lastHuman?.data.kind ?? "none")} with failed gate ${failedGate ?? "none"} — refusing`);
    }
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}),
      via: "cli",
      release: REVIEW_UPHELD_RELEASE,
      gate: "review",
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    });
    return disposition(cwd, runId, "fund-fixed-attempt", `upheld the reviewer for ${taskId} in ${runId} — by ${by}`, serialization.contended);
  }
  if (recheck) {
    if ((!gateFailPark || !failedGate) && !infraPark) {
      throw new Error(`--recheck applies to a gate-fail, infra or diff-cap park; ${taskId}'s newest park is ${String(lastHuman?.data.kind ?? "none")} with failed gate ${failedGate ?? "none"} — refusing`);
    }
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}),
      via: "cli",
      release: RECHECK_RELEASE,
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    });
    return disposition(cwd, runId, "re-dispatch", `re-checking ${taskId} in ${runId} — by ${by}; ${failedGate ? `failed gate ${failedGate}` : `${park!.kind} park`}; no gate marked satisfied`, serialization.contended);
  }
  if (waive) {
    if (!gateFailPark || !failedGate) {
      throw new Error(`--waive applies to a gate-fail park; ${taskId}'s newest park is ${String(lastHuman?.data.kind ?? "none")} with failed gate ${failedGate ?? "none"} — refusing`);
    }
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}),
      via: "cli",
      release: GATE_SATISFIED_RELEASE,
      gate: failedGate,
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    });
    return disposition(cwd, runId, "waive-gate", `waived failed gate ${failedGate} for ${taskId} in ${runId} — by ${by}`, serialization.contended);
  }
  if (gateFailPark) {
    const choices = [`--waive (disposition waive-gate)`, `--recheck (disposition re-dispatch)`];
    if (failedGate === "review") choices.push(`--uphold (disposition fund-fixed-attempt)`);
    throw new Error(`task ${taskId} is parked on failed gate ${failedGate}; plain approve has disposition only for non-gate parks — pass ${choices.join(" or ")}`);
  }

  // A tombstone has no verb in permittedDecisionVerbs (the named decisions above already refused it
  // as a non-gate park); the command enforces the same table for plain approve, so a surface that
  // skips the helper still cannot release it.
  if (park?.tombstone) {
    throw new Error(`task ${taskId}'s newest park is a tombstone (${park.reason ?? "no reason"}) — permanent by design; no verb releases it`);
  }
  // OBS-1007: a cap trip is re-gated under a raised cap, never re-bought — plain approve would fund a
  // worker the production oracle (permittedDecisionVerbs) says this park cannot buy.
  if (park?.kind === "diff-cap") {
    throw new Error(`task ${taskId} is parked on a diff cap; plain approve would fund another worker — raise gates.diffCap and pass --recheck (disposition re-dispatch)`);
  }

  journal.append("task-approved", taskId, {
    by,
    ...(reason ? { reason } : {}),
    via: "cli",
    ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    ...(capPark ? { release: ATTEMPT_CAP_RELEASE } : {}),
  });
  const token = capPark ? "fresh-budget" : "dispatch";
  return disposition(cwd, runId, token, `approved ${taskId} in ${runId} — by ${by}`, serialization.contended);
  } finally {
    serialization.release();
  }
}

/**
 * OBS-1022: what a failed task has landed. A preserved snapshot is authoritative only when it contains
 * the current task-branch tip; an older preservation can remain in the journal after a later retry has
 * advanced/rebuilt the branch. Missing task branches may still recover from a preserved ref. The selected
 * ref is counted against the run's integration branch; unreadable refs count as zero and fail closed.
 */
function failedTaskCommitsAhead(cwd: string, journal: Journal, runId: string, taskId: string): { ref: string; base: string; count: number } {
  const cfg = loadConfig(cwd);
  const base = integrationBranch(cfg, runId);
  const taskRef = `${base}--${taskId}`;
  const preserved = [...journal.read()].reverse().find((e) => e.taskId === taskId && e.event === "worktree-preserved" && typeof e.data.ref === "string");
  const preservedRef = preserved?.data.ref as string | undefined;
  let ref = taskRef;
  if (preservedRef) {
    try {
      execFileSync("git", ["rev-parse", "--verify", taskRef], { cwd, stdio: "ignore" });
      execFileSync("git", ["merge-base", "--is-ancestor", taskRef, preservedRef], { cwd, stdio: "ignore" });
      ref = preservedRef;
    } catch {
      try {
        execFileSync("git", ["rev-parse", "--verify", taskRef], { cwd, stdio: "ignore" });
      } catch {
        ref = preservedRef;
      }
    }
  }
  try {
    const out = execFileSync("git", ["rev-list", "--count", `${base}..${ref}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { ref, base, count: Number.parseInt(out.trim(), 10) || 0 };
  } catch {
    return { ref, base, count: 0 };
  }
}

// The status is command OUTPUT, not a typed sibling result: the registered approve function returns
// one primitive string and the dispatcher prints those bytes unchanged. A compact sentinel followed
// by JSON makes the contract unambiguous to machines without widening the shared command result type.
// No-lock approvals keep their historical one-line result for the cockpit; a dead recorded owner, a
// live owner executing some OTHER run, and a command delayed behind terminalization all emit
// recorded-no-owner — none of them is a daemon that will sweep this run's approvals.
//
// The ENACTMENT half of the message is completed here because only here is liveness known: the call
// sites carry the decision, not the answer to who will act on it. `deferred-live` keeps its v1.89
// token — machine consumers parse it — while its TEXT now names the boundary sweep. A recovery
// command is emitted only with no live repository owner; a different run's live owner instead names
// the blocker and waits until it ends.
function disposition(cwd: string, runId: string, token: ApprovalDisposition, message: string, contended: boolean): string {
  const owner = runLockOwner(cwd);
  const run = ownedByLiveDaemon(owner, runId);
  const out = `approval disposition ${token}: ${message}; ${approvalEnactment(token, run)}`;
  if (!owner && !contended) return out;
  const status: ApprovalStatus = run.live ? "deferred-live" : "recorded-no-owner";
  const record = {
    status,
    disposition: token,
    // Resume is safe to prescribe only when no live repository owner would contend with it.
    ...(!run.live && !run.blockingRunId ? { resume: `tickmarkr resume ${runId}` } : {}),
    ...(owner?.pid === undefined ? {} : { ownerPid: owner.pid }),
    ...(owner?.runId === undefined ? {} : { ownerRunId: owner.runId }),
  };
  return `${out}\nTICKMARKR_APPROVAL ${JSON.stringify(record)}`;
}

interface ParsedArgs {
  files?: string[];
  runId: string;
  taskId: string;
  by: string;
  reason?: string;
  waive: boolean;
  uphold: boolean;
  recheck: boolean;
  reviewRoundCeiling?: number;
}

const USAGE = "usage: tickmarkr approve <run-id> <task-id> [--files <glob,…>] [--waive|--uphold|--recheck] [--review-rounds <positive-integer>] [--by <name>] [--reason <text>]";

// hand-parsed argv — no CLI framework (house style). Positionals are runId then taskId; decision,
// ceiling, actor and reason are flags. Throws usage on missing positionals (mirrors resume.ts/unlock.ts).
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let files: string[] | undefined;
  let by: string | undefined;
  let reason: string | undefined;
  let waive = false;
  let uphold = false;
  let recheck = false;
  let reviewRoundCeiling: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--files requires <glob,…>");
      files = value.split(",").map((file) => file.trim());
      if (files.some((file) => !file || file.startsWith("/") || file.startsWith("!") || file.split("/").includes(".."))) {
        throw new Error("--files requires non-empty repository-relative globs");
      }
    } else if (a === "--by") {
      by = argv[++i];
      if (!by) throw new Error(USAGE);
    } else if (a === "--reason") {
      reason = argv[++i];
      if (!reason) throw new Error(USAGE);
    } else if (a === "--waive") {
      waive = true;
    } else if (a === "--uphold") {
      uphold = true;
    } else if (a === "--recheck") {
      recheck = true;
    } else if (a === "--review-rounds") {
      const value = argv[++i];
      if (value === undefined) throw new Error(USAGE);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--review-rounds must be a positive integer");
      }
      reviewRoundCeiling = Number(value);
    } else {
      positionals.push(a);
    }
  }
  const [runId, taskId] = positionals;
  if (!runId || !taskId) {
    throw new Error(USAGE);
  }
  return { runId, taskId, by: by ?? userInfo().username, reason, waive, uphold, recheck, reviewRoundCeiling, files };
}

function failedGateForNewestPark(events: readonly JournalEvent[], taskId: string, lastHumanIndex: number): string | undefined {
  for (let i = lastHumanIndex - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.taskId !== taskId) continue;
    if (event.event === "task-approved" || event.event === "task-human" || event.event === "task-dispatch") return undefined;
    if (event.event === "gate-result" && event.data.pass === false
        && typeof event.data.gate === "string" && (GATE_NAMES as readonly string[]).includes(event.data.gate)) {
      return event.data.gate;
    }
  }
  return undefined;
}
