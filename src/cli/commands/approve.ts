import { graphDefinitionHash, loadGraph, saveGraph, taskDefinitionFingerprint } from "../../graph/graph.js";
import { userInfo } from "node:os";
import { allAdapters } from "../../adapters/registry.js";
import { channelKey } from "../../adapters/types.js";
import { loadConfig } from "../../config/config.js";
import { integrationBranch } from "../../run/merge.js";
import { gitSync } from "../../run/git.js";
import { integrationAnchor } from "../../run/daemon.js";
import { separabilityConflicts, surfaceErrors, taskBudgetErrors } from "../../compile/collateral.js";
import { GATE_NAMES, type GateName, type Task } from "../../graph/schema.js";
import { applyScopeAmendments, bindingToken, captureOwedCheck, engagementComparable, engagementReleased, failedGateRowBeforePark, noVerdictReview, parseBindingToken, physicalLine, ATTEMPT_CAP_RELEASE, GATE_SATISFIED_RELEASE, Journal, RECHECK_RELEASE, REVIEW_UPHELD_RELEASE, type DecisionBinding, type JournalEvent } from "../../run/journal.js";

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
  // Row 413 (D-2187 add.69): a recheck's preview is the park sentence; repair is selected only by an explicit --on-red repair.
  "re-dispatch": RECHECK_ENACTS[DEFAULT_ON_RED],
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

import { permittedDecisionVerbs, type DecisionPark, type DecisionVerb } from "../../run/decision-verbs.js";
import { waiveProof } from "../../run/waive-proof.js";
import { grantSlotFiles, readFilesValue } from "../files-flag.js";
import { DEFAULT_ON_RED, parseOnRed, RECHECK_ENACTS, type OnRed } from "../../run/recheck-disposition.js";
export { DECISION_VERBS, permittedDecisionVerbs, type DecisionVerb } from "../../run/decision-verbs.js";

/** Row 418: the enabled gates an infra park recorded; absent or malformed → every gate (the strictest proof). */
const parkGates = (v: unknown): readonly string[] =>
  Array.isArray(v) && v.length > 0 && v.every((g) => typeof g === "string") ? v as string[] : GATE_NAMES;

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
  /** OBS-1202: a stall park's recorded reap failure (task-human data.reapFailure) — its census is unproven. */
  reapFailure?: string;
  reviewWaiveProof?: DecisionPark["reviewWaiveProof"];
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
    const failed = failedGateRowBeforePark(events, taskId, i);
    const failedGate = failed?.gate;
    return {
      index: i, line: sourceIndexes?.[i] === undefined ? physicalLine(events, i) : sourceIndexes[i]! + 1, ts: typeof e.ts === "string" ? e.ts : undefined, kind, reason,
      approveCommand: typeof e.data.approveCommand === "string" ? e.data.approveCommand : undefined,
      failedGate, tombstone: isTombstonePark(kind, reason),
      ...(kind === "stall" && typeof e.data.reapFailure === "string" ? { reapFailure: e.data.reapFailure } : {}),
      // Row 418 (D-2187 add.84): the proof reader decides whether this infra review park admits a waive.
      // Only the row the park's failed gate was read from, and only a no-verdict one (a pass:false review
      // of an infra park keeps approve and recheck); the enabled gates are the ones the park recorded,
      // so every surface reads one proof — unrecorded → every gate, never a laxer proof.
      ...(kind === "infra" && failed?.gate === "review" && noVerdictReview(events[failed.index]!.data)
        ? { reviewWaiveProof: waiveProof(events.slice(0, i + 1), taskId, parkGates(e.data.enabledGates)) } : {}),
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

/** OBS-1178: the token a park is decided by — what status, park notices and the cockpit print. */
export const parkToken = (park: Pick<NewestPark, "line" | "ts">): string | undefined =>
  park.ts === undefined ? undefined : bindingToken({ line: park.line, ts: park.ts });

/** OBS-1178: the newest task-failed row for a task — the failure a failed-task recheck binds to. */
export function newestFailure(events: readonly JournalEvent[], taskId: string, sourceIndexes?: readonly number[]): DecisionBinding | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === "task-failed" && e.taskId === taskId && typeof e.ts === "string") return { line: sourceIndexes?.[i] === undefined ? physicalLine(events, i) : sourceIndexes[i]! + 1, ts: e.ts };
  }
  return undefined;
}

const TOOL_GATES: readonly string[] = ["build", "test", "lint"];
const isToolGate = (gate: string | undefined): gate is string => gate !== undefined && TOOL_GATES.includes(gate);

/** Exact literals in the shared files[] matcher, including its literal parentheses convention. */
function grantableRepairPath(path: string): boolean {
  return /^[A-Za-z0-9/ #$%&'()+\-.:;<=>@\]^_}~`]+$/.test(path)
    && !path.startsWith(":") && !path.startsWith("/") && !path.endsWith("/")
    && !path.startsWith(" ") && !path.endsWith(" ")
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
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
export function approvalEnactment(token: ApprovalDisposition, run: ApprovalRunOwner, enacts = APPROVAL_ENACTS[token]): string {
  if (run.live) {
    return `the live daemon enacts this at its next task boundary — it will ${enacts}, including in the approval window or by cancelling an in-progress tip verify`;
  }
  if (run.blockingRunId) {
    return `release recorded; live run \`${run.blockingRunId}\` holds the repository lock, so resume \`${run.runId}\` after it ends to ${enacts}`;
  }
  return `run \`tickmarkr resume ${run.runId}\` to ${enacts}`;
}

/** The production command registered in COMMANDS; its returned bytes are what the CLI prints. */
export async function approve(argv: string[], cwd = process.cwd()): Promise<string> {
  const { runId, taskId, by, reason, ruling, waive, uphold, recheck, onRed, reviewRoundCeiling, files, park: namedPark, gate: namedGate } = parseArgs(argv);
  const decisions = [waive, uphold, recheck].filter(Boolean).length;
  if (decisions > 1) throw new Error("--waive, --uphold and --recheck are different decisions — pass one");
  // OBS-1178: the decision binds at COMMAND time — to the named --park, else to the park (or, for a
  // failed task's recheck, the failure) open now — and is revalidated under serialization below. A
  // decision queued behind another approval can therefore never land on a park that opened meanwhile.
  // Journal.open throws `no journal for <runId> at <dir>` on an unknown run — that IS the refusal.
  const bound = namedPark ?? openDecision(Journal.open(cwd, runId), taskId);
  const serialization = await acquireApprovalSerialization(cwd, runId);

  try {
  const journal = Journal.open(cwd, runId);
  // 2.8.1 T3 (ANL-023 §7.3): a marked run's recheck counts against its journal anchor; an unreadable one admits nothing.
  const anchor = integrationAnchor(journal.read());
  if (recheck && anchor && "unreadable" in anchor) {
    throw new Error(`refusing to recheck ${taskId} in ${runId}: its journal names no readable published tip (${anchor.unreadable})`);
  }

  const status = journal.replayStatuses().get(taskId);
  if (status === undefined) {
    throw new Error(`task ${taskId} has no events in run ${runId} — unknown task or never dispatched`);
  }
  const refuseFiles = (why: string): never => {
    throw new Error(`refusing --files for ${taskId}: ${files?.join(",")} — ${why}`);
  };
  if (files !== undefined && status !== "human") refuseFiles(`task is ${status}, not a parked human gate`);
  // OBS-1022: a task-failed task whose preserved ref (or task branch) carries commits ahead of the
  // integration base owns verified-able work; --recheck re-gates that tree with no worker. Any other
  // verb on a failed task, or a recheck over nothing landed, is refused naming why.
  if (status === "failed" && recheck) {
    if (namedGate !== undefined) throw new Error(`--gate names a parked failed gate; task ${taskId} is failed — bind its recheck with --park <failure token>`);
    const { events: failedEvents, sourceIndexes: failedIndexes } = readJournalEvents(journal);
    const failure = requireBound(runId, taskId, bound, newestFailure(failedEvents, taskId, failedIndexes), "failure");
    const ahead = failedTaskCommitsAhead(cwd, journal, runId, taskId);
    if (ahead.count === 0) {
      throw new Error(`task ${taskId} is failed and ${ahead.ref} carries no commits ahead of ${ahead.base} — nothing to re-gate; use resume --retry-failed to fund a worker`);
    }
    journal.append("task-approved", taskId, {
      by, ...(reason ? { reason } : {}), ...rulingField(ruling), via: "cli", release: RECHECK_RELEASE,
      recheckedRef: ahead.ref, commitsAhead: ahead.count, failure, onRed,
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    });
    return disposition(cwd, runId, "re-dispatch", `re-checking failed ${taskId} in ${runId} — by ${by}; ${ahead.count} commit(s) on ${ahead.ref} ahead of ${ahead.base}; no worker funded`, serialization.contended, RECHECK_ENACTS[onRed]);
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
  const authoringRunnerPark = park?.kind === "authoring" && isToolGate(park.failedGate);
  const reapFailurePark = park?.kind === "stall" && park.reapFailure !== undefined;
  const failedGate = gateFailPark || authoringRunnerPark ? park?.failedGate : undefined;
  const parkBinding = requireBound(runId, taskId, bound, park?.ts === undefined ? undefined : { line: park.line, ts: park.ts }, "park");
  if (namedGate !== undefined && namedGate !== park?.failedGate) {
    throw new Error(`refusing mismatched gate for ${taskId}: --gate ${namedGate} but park ${bindingToken(parkBinding)} failed ${park?.failedGate ?? "no gate"} — nothing appended`);
  }
  // A scope-request park is released one of two ways: --files widens files[], or a nonempty --reason
  // refuses the expansion and funds a plain worker within the current files[] — the reason rides into
  // the next brief as a standing ruling (journaledFailureBrief). No reason, no release: the refusal is
  // a ruling only when it says why. The cockpit menu still offers neither (it has no reason entry).
  const scopeRefusal = park?.kind === "scope-request" && !decisions && files === undefined && Boolean(reason?.trim());
  let amendment: Record<string, unknown> | undefined;
  let materializeAmendment: (() => void) | undefined;
  if ((park?.kind === "scope-request" && !decisions && !scopeRefusal) || files !== undefined) {
    const scopeRequest = park?.kind === "scope-request";
    // Row 411 (D-2187 add.148): a scope-request value is read by the two agreeing readers; a hint grant keeps the comma split.
    const grantFiles = scopeRequest && files !== undefined ? readFilesValue(files.join(",")) : files;
    if (!scopeRequest) {
      // Admit the verb BEFORE constructing an amendment. A hint grants no new decision authority.
      const verb = uphold ? "uphold" : recheck ? "recheck" : undefined;
      if (!verb || !permittedDecisionVerbs(park).includes(verb)) {
        refuseFiles("requires an admitted --uphold or --recheck decision on the newest park");
      }
      const hint = lastHuman?.data.repairHint;
      if (!Array.isArray(hint) || !hint.length || !hint.every((path) => typeof path === "string")) {
        refuseFiles("newest park has no recorded repairHint paths");
      }
      for (const path of files ?? []) {
        if (!grantableRepairPath(path)) refuseFiles(`path ${path} is not a grantable literal repair hint`);
        if (!(hint as string[]).includes(path)) refuseFiles(`path ${path} is not a recorded repair hint`);
      }
    } else {
      // Preserve scope-request's comma-separated, trimmed glob parsing. Hint grants use raw paths.
      if (files?.join(",").startsWith("--") || files?.join(",") === "") throw new Error("--files requires <glob,…>");
      if (grantFiles?.some((file) => !file.trim() || file.trim().startsWith("/") || file.trim().startsWith("!") || file.trim().split("/").includes(".."))) {
        throw new Error("--files requires non-empty repository-relative globs");
      }
    }
    if (!grantFiles?.length) {
      throw new Error(`scope-request for ${taskId} requires --files <glob,…> to widen files[], or \`tickmarkr approve ${runId} ${taskId} --reason <text>\` to refuse the expansion and continue within the current files[]`);
    }
    if (scopeRequest && decisions) throw new Error("--files cannot be combined with --waive, --uphold or --recheck");
    const refuseGrant = (message: string): never => {
      if (!scopeRequest) refuseFiles(message);
      throw new Error(message);
    };
    const graph = applyScopeAmendments(loadGraph(cwd), journal, false, engagementReleased(events));
    const from = graphDefinitionHash(graph);
    if (!engagementComparable(journal.read(), from).comparable
        || (lastHuman?.data.graphDefinitionHash !== undefined && lastHuman.data.graphDefinitionHash !== from)) {
      refuseGrant(`refusing stale scope-request approval for ${taskId}: graph revision changed`);
    }
    const task = graph.tasks.find((t) => t.id === taskId);
    if (!task) return refuseGrant(`unknown task ${taskId}`);
    const amendedFiles = [...new Set([...task.files, ...grantFiles.map((file) => scopeRequest ? file.trim() : file)])];
    if (amendedFiles.length === task.files.length) refuseGrant("--files must extend the parked files[] revision");
    const amended = { ...graph, tasks: graph.tasks.map((t) => t.id === taskId ? { ...t, files: amendedFiles } : t) };
    const conflicts = scopeGrantConflicts(cwd, journal, runId, taskId, amended.tasks, events);
    if (conflicts.length) refuseGrant(`refusing scope-request approval for ${taskId}: ${conflicts.join("\n")}`);
    // C4: a live grant may not take a task past the bounds that fail every compile. The exception
    // list is EMPTY on purpose — a recorded historical compile exception confers no live authority.
    // Row 411 (D-2187 add.65): compiled patterns plus ONE slot for every grant together.
    const slotted = { ...task, files: grantSlotFiles(journal.read(), taskId, task.files) };
    const overBound = [...taskBudgetErrors([slotted]), ...surfaceErrors([slotted], [])];
    if (overBound.length) {
      refuseGrant(`refusing scope-request approval for ${taskId}: ${overBound.join("\n")}\n`
        + `remedy: close the run, split the task in its spec, recompile, then \`tickmarkr resume ${runId} --graph-changed\``);
    }
    amendment = { from, to: graphDefinitionHash(amended), beforeFiles: task.files, files: amendedFiles, parkLine: park!.line, definition: taskDefinitionFingerprint(task) };
    // Do not write graph.json from this process while the daemon owns it: its sweep materializes
    // the amendment without replacing a sibling's running state with this command's snapshot.
    materializeAmendment = () => {
      const projected = applyScopeAmendments(graph, journal, false, engagementReleased(events));
      const owner = approvalRunOwner(cwd, runId);
      if (!owner.live && !owner.blockingRunId) saveGraph(cwd, projected);
    };
    if (scopeRequest) {
      journal.append("task-approved", taskId, {
        by, ...(reason ? { reason } : {}), ...rulingField(ruling), via: "cli", release: "scope-request", park: parkBinding,
        ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }), // OBS-1083
        amendment,
      });
      materializeAmendment();
      return disposition(cwd, runId, "dispatch", `approved files[] for ${taskId} in ${runId} — by ${by}`, serialization.contended);
    }
  }

  if (gateFailPark && !failedGate) {
    throw new Error(`task ${taskId} is parked on gate-fail but has no failed gate result on the newest park — refusing to infer one`);
  }

  if (uphold) {
    if (!permittedDecisionVerbs(park).includes("uphold")) {
      throw new Error(`--uphold applies to a review gate-fail park; ${taskId}'s newest park is ${String(lastHuman?.data.kind ?? "none")} with failed gate ${failedGate ?? "none"} — refusing`);
    }
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}), ...rulingField(ruling),
      via: "cli",
      release: REVIEW_UPHELD_RELEASE,
      gate: "review",
      park: parkBinding,
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
      ...(amendment === undefined ? {} : { amendment }),
    });
    materializeAmendment?.();
    return disposition(cwd, runId, "fund-fixed-attempt", `upheld the reviewer for ${taskId} in ${runId} — by ${by}`, serialization.contended);
  }
  if (recheck) {
    if (park?.kind === "stall" && !reapFailurePark) {
      throw new Error(`--recheck applies to a stall park only when it recorded a reapFailure (census recovery); ${taskId}'s stall park recorded none — plain approve dispatches a worker; refusing`);
    }
    if (!permittedDecisionVerbs(park).includes("recheck")) {
      throw new Error(`--recheck applies to a gate-fail, infra, diff-cap or red-tool-gate authoring park; ${taskId}'s newest park is ${String(lastHuman?.data.kind ?? "none")} with failed gate ${failedGate ?? "none"} — refusing`);
    }
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}), ...rulingField(ruling),
      via: "cli",
      release: RECHECK_RELEASE,
      onRed, // row 413 (D-2187 add.69): the red battery's disposition, recorded where the daemon reads it
      park: parkBinding,
      // OBS-1084: failedGate names the runner report for every recheck. Authoring rechecks additionally
      // carry gate so their durable release row identifies the red tool gate that made recheck admissible.
      ...(failedGate ? { failedGate } : {}),
      ...(authoringRunnerPark && failedGate ? { gate: failedGate } : {}),
      // OBS-1202: the daemon re-verifies the parked attempt's owned census before any gate runs.
      ...(reapFailurePark ? { reapFailure: park!.reapFailure } : {}),
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
      ...(amendment === undefined ? {} : { amendment }),
    });
    materializeAmendment?.();
    return disposition(cwd, runId, "re-dispatch", `re-checking ${taskId} in ${runId} — by ${by}; ${failedGate ? `failed gate ${failedGate}` : reapFailurePark ? "reapFailure stall park; the owned census is re-verified before the gates" : `${park!.kind} park`}; no gate marked satisfied`, serialization.contended, RECHECK_ENACTS[onRed]);
  }
  if (waive) {
    if (!permittedDecisionVerbs(park).includes("waive")) {
      const proof = park?.reviewWaiveProof;
      throw new Error(`--waive applies to a gate-fail park${proof?.ok === false ? ` or a proved infra review park (row 418: ${proof.reason})` : ""}; ${taskId}'s newest park is ${String(lastHuman?.data.kind ?? "none")} with failed gate ${park?.failedGate ?? "none"} — refusing`);
    }
    const failedGate = park!.failedGate; // a gate-fail park's, or row 418's no-verdict review of an infra park
    // C1: the waiver's owed check rides the SAME row — one append, captured synchronously so a live
    // daemon's boundary never observes the decision without its obligation (or a second write).
    // The seats a review discharge may resolve to are this repository's declared channels, recorded on
    // the row so every later fold reads the same table whatever process or checkout it runs in.
    let byName = "unknown";
    let declared: Array<{ key: string; vendor: string }> | undefined;
    let owedTask: { acceptance?: unknown; files?: unknown } | undefined;
    try {
      const cfg = loadConfig(cwd);
      byName = integrationBranch(cfg, runId);
      declared = allAdapters().flatMap((a) => a.channels(cfg)).map((c) => ({ key: channelKey(c), vendor: c.vendor }));
    } catch { /* an unreadable config binds no range and declares no seat: unknown */ }
    try { owedTask = loadGraph(cwd).tasks.find((t) => t.id === taskId); } catch { /* recorded as unknown criteria and scope */ }
    const integration = integrationBase(journal.read(), () => byName);
    const owed = captureOwedCheck({
      cwd, runId, taskId, gate: failedGate as GateName, events, acceptance: owedTask?.acceptance, files: owedTask?.files, declared,
      cause: reason ?? `operator waived failed ${failedGate} gate`, // the row's own park field binds the park
      taskRef: `${integration.branch}--${taskId}`, integrationRef: integration.base,
    });
    // An unreadable anchor still records the waive, its obligation unknown: the debt is never silently known.
    const obligation = integration.unreadable === undefined ? owed
      : { ...owed, known: false, unknownReason: `its journal names no readable published tip (${integration.unreadable})` };
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}), ...rulingField(ruling),
      via: "cli",
      release: GATE_SATISFIED_RELEASE,
      gate: failedGate,
      park: parkBinding,
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
      obligation,
    });
    return disposition(cwd, runId, "waive-gate", `waived failed gate ${failedGate} for ${taskId} in ${runId} — by ${by}; owes ${failedGate} check ${obligation.id}${obligation.known ? "" : " (debt unknown)"}`, serialization.contended);
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
    ...(reason ? { reason } : {}), ...rulingField(ruling),
    via: "cli",
    ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    ...(capPark ? { release: ATTEMPT_CAP_RELEASE } : {}),
    park: parkBinding,
  });
  const token = capPark ? "fresh-budget" : "dispatch";
  return disposition(cwd, runId, token, `approved ${taskId} in ${runId} — by ${by}${scopeRefusal ? "; scope expansion refused, files[] unchanged" : ""}`, serialization.contended);
  } finally {
    serialization.release();
  }
}

/**
 * 2.8.1 T3 (ANL-023 §7.3): the integration branch and base a decision reads. A marked run (run-start
 * `integrationAnchor: "journal"`) takes its branch from run-start, never the current config, and its base is the
 * journal anchor A (`unreadable` when the journal names none); an unmarked run reads the branch by name, as before.
 */
function integrationBase(events: readonly JournalEvent[], byName: () => string): { branch: string; base: string; unreadable?: string } {
  const anchor = integrationAnchor(events);
  if (!anchor) {
    const branch = byName();
    return { branch, base: branch };
  }
  const branch = String(events.find((e) => e.event === "run-start")!.data.branch);
  return "anchor" in anchor ? { branch, base: anchor.anchor } : { branch, base: "unknown", unreadable: anchor.unreadable };
}

/**
 * Queue 169 (D-1982/D-1983/D-1986): the in-run OBS-212 check a scope-request grant runs. Only the
 * pairs this amendment changes are judged — the requester against each unordered sibling; a pair
 * another amendment created was judged by that grant and is never re-judged here. A sibling is
 * exempt only when this run already merged it into the requester's branch: its replayed status is
 * done, its NEWEST journaled merge row names a full lowercase object id, and that commit is an
 * ancestor of the requester's task branch (the run's integration branch plus --taskId, read exactly
 * as the failed-task recheck reads it — a marked run's branch comes from its run-start record, never
 * the current config). Every other overlapping pair keeps the compile-time refusal, an unreadable
 * git answer included. The surviving errors are separabilityErrors' own rows, so the refusal text
 * and its pair order are unchanged.
 */
function scopeGrantConflicts(
  cwd: string, journal: Journal, runId: string, requesterId: string,
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "deps">>, events: readonly JournalEvent[],
): string[] {
  // Row 414 (D-2187 add.71): compile's own pair fold and overlap, so the two cannot misalign.
  const conflicts = separabilityConflicts(tasks);
  if (!conflicts.length) return [];
  const statuses = journal.replayStatuses();
  let taskRef: string | undefined;
  const requesterRef = () => (taskRef ??= `${integrationBase(events, () => integrationBranch(loadConfig(cwd), runId)).branch}--${requesterId}`);
  const kept: string[] = [];
  for (const { a, b, error } of conflicts) {
    const sibling = a === requesterId ? b : b === requesterId ? a : undefined;
    if (sibling === undefined) continue;
    if (mergedSiblingExempt(cwd, events, statuses.get(sibling), sibling, requesterRef)) continue;
    kept.push(error);
  }
  return kept;
}

/** A full lowercase git object id: 40 (SHA-1) or 64 (SHA-256) hex, nothing else. */
const FULL_OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The one exemption: the sibling is done in THIS run's replay and its newest merge row's commit is a
 * full object id that is an ancestor of the requester's task branch. Any unreadable git answer — a
 * missing requester branch, a commit the repository lacks, a failed ancestry read — is no exemption.
 */
function mergedSiblingExempt(
  cwd: string, events: readonly JournalEvent[], status: string | undefined, siblingId: string, requesterRef: () => string,
): boolean {
  if (status !== "done") return false;
  const merge = [...events].reverse().find((e) => e.event === "merge" && e.taskId === siblingId);
  const commit = typeof merge?.data.commit === "string" ? merge.data.commit : undefined;
  if (commit === undefined || !FULL_OBJECT_ID.test(commit)) return false;
  const ref = requesterRef();
  return gitOk(cwd, "rev-parse", "--verify", ref) && gitOk(cwd, "merge-base", "--is-ancestor", commit, ref);
}

/** Queue row 2 item b: approve's git runs through the protected path; a trust refusal throws, never reads as false. */
const gitOk = (cwd: string, ...args: string[]): boolean => gitSync(cwd, args).status === 0;

/** The row a decision on this task answers right now: its newest failure when failed, else its newest park. */
function openDecision(journal: Journal, taskId: string): DecisionBinding | undefined {
  const { events, sourceIndexes } = readJournalEvents(journal);
  if (journal.replayStatuses().get(taskId) === "failed") return newestFailure(events, taskId, sourceIndexes);
  const park = newestPark(events, taskId, sourceIndexes);
  return park?.ts === undefined ? undefined : { line: park.line, ts: park.ts };
}

/** OBS-1178: under serialization, the decision's command-time binding must still name the open row. */
function requireBound(runId: string, taskId: string, bound: DecisionBinding | undefined, open: DecisionBinding | undefined, what: "park" | "failure"): DecisionBinding {
  if (open === undefined) throw new Error(`task ${taskId} has no ${what} row with a timestamp to bind this decision to — refusing an unbound release`);
  if (bound === undefined || bound.line !== open.line || bound.ts !== open.ts) {
    throw new Error(`refusing stale decision for ${taskId}: bound to ${bound === undefined ? "no open row" : `${what} ${bindingToken(bound)}`} but the open ${what} is ${bindingToken(open)} — read \`tickmarkr status ${runId}\` and decide the open ${what}; nothing appended`);
  }
  return open;
}

/**
 * OBS-1022: what a failed task has landed. A preserved snapshot is authoritative only when it contains
 * the current task-branch tip; an older preservation can remain in the journal after a later retry has
 * advanced/rebuilt the branch. Missing task branches may still recover from a preserved ref. The selected
 * ref is counted against the run's integration base (integrationBase); unreadable refs count as zero and fail closed.
 * `base` names the branch the text prints; the count reads `integration.base`.
 */
function failedTaskCommitsAhead(cwd: string, journal: Journal, runId: string, taskId: string): { ref: string; base: string; count: number } {
  const integration = integrationBase(journal.read(), () => integrationBranch(loadConfig(cwd), runId));
  const base = integration.branch;
  const taskRef = `${base}--${taskId}`;
  const preserved = [...journal.read()].reverse().find((e) => e.taskId === taskId && e.event === "worktree-preserved" && typeof e.data.ref === "string");
  const preservedRef = preserved?.data.ref as string | undefined;
  let ref = taskRef;
  if (preservedRef) {
    if (gitOk(cwd, "rev-parse", "--verify", taskRef) && gitOk(cwd, "merge-base", "--is-ancestor", taskRef, preservedRef)) ref = preservedRef;
    else if (!gitOk(cwd, "rev-parse", "--verify", taskRef)) ref = preservedRef;
  }
  const out = gitSync(cwd, ["rev-list", "--count", `${integration.base}..${ref}`]);
  return { ref, base, count: out.status === 0 ? Number.parseInt(out.stdout.trim(), 10) || 0 : 0 };
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
function disposition(cwd: string, runId: string, token: ApprovalDisposition, message: string, contended: boolean, enacts?: string): string {
  const owner = runLockOwner(cwd);
  const run = ownedByLiveDaemon(owner, runId);
  const out = `approval disposition ${token}: ${message}; ${approvalEnactment(token, run, enacts)}`;
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
  /** OBS-1178: `--park <line>@<ts>` — the park (or failed task's failure) this decision answers. */
  park?: DecisionBinding;
  /** OBS-1178: `--gate <gate>` — the failed gate the bound park must carry. */
  gate?: string;
  runId: string;
  taskId: string;
  by: string;
  reason?: string;
  /** Row 419 (D-2187 add.89): `--ruling <text>`, repeatable — recorded apart from the reason. */
  ruling: string[];
  waive: boolean;
  uphold: boolean;
  recheck: boolean;
  /** Row 413: `--on-red <park|repair>` — park when absent (approve applies the default when it writes). */
  onRed: OnRed;
  reviewRoundCeiling?: number;
}

/** Row 419: the decision row's `ruling` field — absent when none was passed. */
const rulingField = (ruling: readonly string[]): { ruling?: string[] } => ruling.length ? { ruling: [...ruling] } : {};

const USAGE = "usage: tickmarkr approve <run-id> <task-id> [--park <line>@<ts>] [--gate <gate>] [--files <glob,…>] [--waive|--uphold|--recheck [--on-red <park|repair>]] [--review-rounds <positive-integer>] [--by <name>] [--reason <text>] [--ruling <text>]…";

// hand-parsed argv — no CLI framework (house style). Positionals are runId then taskId; decision,
// ceiling, actor and reason are flags. Throws usage on missing positionals (mirrors resume.ts/unlock.ts).
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let files: string[] | undefined;
  let park: DecisionBinding | undefined;
  let gate: string | undefined;
  let by: string | undefined;
  let reason: string | undefined;
  const ruling: string[] = [];
  let waive = false;
  let uphold = false;
  let recheck = false;
  let onRed: OnRed | undefined;
  let reviewRoundCeiling: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--files requires <glob,…>");
      files = value.split(",");
    } else if (a === "--park") {
      const value = argv[++i];
      park = value === undefined ? undefined : parseBindingToken(value);
      if (!park) throw new Error("--park requires the <line>@<ts> token `tickmarkr status` prints for the park");
    } else if (a === "--gate") {
      gate = argv[++i];
      if (!gate || !(GATE_NAMES as readonly string[]).includes(gate)) throw new Error(`--gate requires one of ${GATE_NAMES.join(", ")}`);
    } else if (a === "--by") {
      by = argv[++i];
      if (!by) throw new Error(USAGE);
    } else if (a === "--reason") {
      reason = argv[++i];
      if (!reason) throw new Error(USAGE);
    } else if (a === "--ruling") {
      const value = argv[++i];
      if (!value?.trim()) throw new Error("--ruling requires <text>");
      ruling.push(value);
    } else if (a === "--waive") {
      waive = true;
    } else if (a === "--uphold") {
      uphold = true;
    } else if (a === "--recheck") {
      recheck = true;
    } else if (a === "--on-red") {
      onRed = parseOnRed(argv[++i]);
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
  if (onRed !== undefined && !recheck) throw new Error(`--on-red applies only to --recheck; ${USAGE}`);
  return { runId, taskId, by: by ?? userInfo().username, reason, ruling, waive, uphold, recheck, onRed: onRed ?? DEFAULT_ON_RED, reviewRoundCeiling, files, park, gate };
}
