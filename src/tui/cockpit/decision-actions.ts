import { join } from "node:path";
import {
  APPROVAL_ENACTS,
  approvalDispositionForRelease,
  approvalEnactment,
  approvalRunOwner,
  approve,
  DECISION_VERBS,
  newestPark,
  permittedDecisionVerbs,
  readJournalEvents,
  releaseForDecision,
  type ApprovalDisposition,
  type ApprovalRunOwner,
  type DecisionVerb,
  type NewestPark,
} from "../../cli/commands/approve.js";
import { stateDirName } from "../../graph/graph.js";
import type { RunGraph } from "../../graph/schema.js";
import { Journal, type JournalEvent } from "../../run/journal.js";

/* ------------------------------------------------------------------------ */
/* C4 — the Run view's one mutation boundary (FINAL §2, §3.3, R22/R23).      */
/*                                                                           */
/* Nothing here validates a decision itself: the production `approve`        */
/* command is the authority, the closed verb table is imported from it, and  */
/* the only truth reported back is the task-approved row the journal file    */
/* actually gained. A preview is a prediction; a receipt is a read-back.     */
/* ------------------------------------------------------------------------ */

/** One parked task and the verbs FINAL §3.3 lets the operator name on it. */
export interface RunDecision {
  readonly taskId: string;
  readonly park: NewestPark;
  /** Count of recorded task-dispatch events — never max(attempt)+1. */
  readonly attempts: number;
  readonly verbs: readonly DecisionVerb[];
  /** Present exactly when `verbs` is empty: why no verb exists, stated instead of invented. */
  readonly diagnostic?: string;
  /** Graph tasks whose deps name this park, when a comparable graph is supplied. */
  readonly blocks: readonly string[];
}

const parkDiagnostic = (park: NewestPark): string | undefined => {
  if (park.tombstone) return "tombstone — permanent by design; no verb releases it";
  if (park.kind === "gate-fail" && park.failedGate === undefined) {
    return "parked on gate-fail with no failed gate result on the newest park — refusing to infer one";
  }
  return undefined;
};

/**
 * The parks the journal's own status replay leaves on a human, in first-named order. The replay is
 * the production one so this surface and `tickmarkr status` can never disagree about what is parked.
 */
export function deriveRunDecisions(journal: Journal, graph?: RunGraph): readonly RunDecision[] {
  const { events, sourceIndexes } = readJournalEvents(journal);
  const decisions: RunDecision[] = [];
  for (const [taskId, status] of journal.replayStatuses()) {
    if (status !== "human") continue;
    const park = newestPark(events, taskId, sourceIndexes);
    if (!park) continue; // a "human" status with no task-human row is not a park this surface can name
    const verbs = permittedDecisionVerbs(park);
    const diagnostic = parkDiagnostic(park);
    decisions.push({
      taskId,
      park,
      attempts: events.filter((e) => e.event === "task-dispatch" && e.taskId === taskId).length,
      verbs,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      blocks: graph?.tasks.filter((t) => t.deps.includes(taskId)).map((t) => t.id) ?? [],
    });
  }
  return decisions;
}

/** A decision the operator has named but not yet confirmed. */
export interface DecisionCommand {
  readonly verb: DecisionVerb;
  readonly taskId: string;
  readonly reason?: string;
  /** `--review-rounds`: the review-round ceiling the release carries. */
  readonly reviewRounds?: number;
}

/** The exact argv the production command receives — built only from the closed verb set. */
export function decisionArgv(command: DecisionCommand, { runId, by }: { runId: string; by: string }): string[] {
  if (!(DECISION_VERBS as readonly string[]).includes(command.verb)) {
    throw new Error(`"${String(command.verb)}" is not a decision verb — permitted: ${DECISION_VERBS.join(", ")}`);
  }
  if (command.reviewRounds !== undefined
      && (!Number.isSafeInteger(command.reviewRounds) || command.reviewRounds < 1)) {
    throw new Error("--review-rounds must be a positive integer");
  }
  const flag = { approve: [], waive: ["--waive"], uphold: ["--uphold"], recheck: ["--recheck"] }[command.verb];
  return [
    runId, command.taskId, ...flag,
    ...(command.reviewRounds === undefined ? [] : ["--review-rounds", String(command.reviewRounds)]),
    "--by", by,
    ...(command.reason === undefined ? [] : ["--reason", command.reason]),
  ];
}

const dispositionForVerb = (verb: DecisionVerb, park: NewestPark): ApprovalDisposition =>
  approvalDispositionForRelease(releaseForDecision(verb, park));

/** The confirm inset's facts, read at preview time. `observedEvents` pins the journal the preview saw. */
export interface DecisionPreview {
  readonly runId: string;
  readonly command: DecisionCommand;
  readonly park: NewestPark;
  readonly actor: string;
  readonly argv: readonly string[];
  readonly release: string | undefined;
  readonly disposition: ApprovalDisposition;
  readonly run: ApprovalRunOwner;
  readonly journalFile: string;
  readonly observedEvents: number;
}

export type DecisionPreviewResult = { ok: true; preview: DecisionPreview } | { ok: false; refusal: string };

export const journalFileFor = (cwd: string, runId: string): string =>
  join(stateDirName(cwd), "runs", runId, "journal.jsonl");

/**
 * Predict the write before naming the one key that can make it. Refuses — appending nothing — when
 * the named verb is outside the park's table, so a confirm inset can never promise a decision the
 * command would refuse. The enactor is read from the run lock now, and read again at the receipt.
 */
export function previewDecision(command: DecisionCommand, { cwd, runId, by }: { cwd: string; runId: string; by: string }): DecisionPreviewResult {
  let argv: string[];
  try { argv = decisionArgv(command, { runId, by }); } catch (e) { return { ok: false, refusal: (e as Error).message }; }
  let events: JournalEvent[];
  let sourceIndexes: number[];
  try { ({ events, sourceIndexes } = readJournalEvents(Journal.open(cwd, runId))); } catch (e) { return { ok: false, refusal: (e as Error).message }; }
  const park = newestPark(events, command.taskId, sourceIndexes);
  if (!park) return { ok: false, refusal: `task ${command.taskId} has no park in run ${runId} — nothing to decide` };
  const verbs = permittedDecisionVerbs(park);
  if (!verbs.includes(command.verb)) {
    const why = parkDiagnostic(park) ?? `permitted: ${verbs.join(", ")}`;
    return { ok: false, refusal: `${command.verb} is not a decision for ${command.taskId}'s ${park.kind ?? "unknown"} park (${why})` };
  }
  const released = events.slice(park.index + 1).find((e) => e.event === "task-approved" && e.taskId === command.taskId);
  if (released) {
    return { ok: false, refusal: `task ${command.taskId} was already released at #L${sourceIndexes[events.indexOf(released)]! + 1} by ${String(released.data.by ?? "unknown")} — nothing to confirm` };
  }
  const release = releaseForDecision(command.verb, park);
  return {
    ok: true,
    preview: {
      runId, command, park, actor: by, argv, release, disposition: dispositionForVerb(command.verb, park),
      run: approvalRunOwner(cwd, runId), journalFile: journalFileFor(cwd, runId), observedEvents: events.length,
    },
  };
}

const parkLine = (park: NewestPark): string =>
  `#L${park.line} ${park.kind ?? "unknown kind"}${park.failedGate ? ` · failed gate ${park.failedGate}` : ""}${park.reason ? ` · ${park.reason}` : ""}`;

const quoteArg = (arg: string): string => (/^[\w.:/@=-]+$/u.test(arg) ? arg : JSON.stringify(arg));

/** What a confirmed write buys, from the command's own table — never a phrase of this file's own. */
function consequenceLines(verb: DecisionVerb, park: NewestPark, release: string | undefined, disposition: ApprovalDisposition): string[] {
  const lines = [`consequence  disposition ${disposition}; appends one task-approved${release ? ` with release ${release}` : " with no release"}`];
  if (verb === "waive") lines.push(`             marks gate ${park.failedGate} satisfied; it does NOT mark the task done`);
  if (verb === "recheck") lines.push("             marks no gate satisfied; the whole declared battery re-runs");
  if (verb === "uphold") lines.push("             sides with the reviewer; funds one fixed attempt carrying the findings");
  lines.push(`             it will ${APPROVAL_ENACTS[disposition]}`);
  return lines;
}

/** Who enacts it — the three lock states, each stated by the command's own sentence. */
export function enactmentLines(run: ApprovalRunOwner, disposition: ApprovalDisposition): string[] {
  const owner = run.live
    ? "enactment    matching live daemon — pending daemon enactment at its next task boundary"
    : run.blockingRunId
      ? `enactment    other live run \`${run.blockingRunId}\` holds the repository lock — recorded, not dispatched`
      : `enactment    no live owner — recorded, not dispatched; resume required: tickmarkr resume ${run.runId}`;
  return [owner, `             ${approvalEnactment(disposition, run)}`];
}

/** The confirm inset: run/task, the newest park line, actor/reason, exact argv, consequence, enactor. */
export function decisionConfirmLines(preview: DecisionPreview): readonly string[] {
  return [
    `run          ${preview.runId}`,
    `task         ${preview.command.taskId}`,
    `park         ${parkLine(preview.park)}`,
    `actor        ${preview.actor}`,
    `reason       ${preview.command.reason ?? "none given"}`,
    `argv         tickmarkr approve ${preview.argv.map(quoteArg).join(" ")}`,
    ...consequenceLines(preview.command.verb, preview.park, preview.release, preview.disposition),
    ...enactmentLines(preview.run, preview.disposition),
    `file         ${preview.journalFile} · append only; cannot be undone`,
    `y ${preview.command.verb} · n cancel · Enter never confirms`,
  ];
}

/** The task-approved row the file gained, located by its physical line. */
export interface AppendedDecision { line: number; event: JournalEvent }

export type DecisionReceipt =
  | {
    readonly ok: true;
    readonly preview: DecisionPreview;
    /** The exact string the production command returned. */
    readonly message: string;
    readonly appended: AppendedDecision;
    readonly release: string | undefined;
    readonly disposition: ApprovalDisposition;
    /** The lock read again after the write — the enactor at receipt time. */
    readonly run: ApprovalRunOwner;
  }
  | {
    readonly ok: false;
    readonly preview: DecisionPreview;
    /** The command's own refusal, or this boundary's — verbatim, and nothing was shown as success. */
    readonly refusal: string;
    /** True when the journal moved past the preview: refresh and preview again. */
    readonly stale?: true;
  };

/**
 * THE write. Re-validates the preview against the journal as it is now (a release appended by another
 * actor after preview refuses instead of appending twice), invokes the production command with the
 * previewed argv, then reads the file back and reports only the task-approved row it actually gained.
 * A successful-looking command whose append cannot be read back is a refusal, never a receipt.
 */
export async function executeDecision(
  preview: DecisionPreview,
  { cwd, command = approve }: { cwd: string; command?: typeof approve },
): Promise<DecisionReceipt> {
  const { runId, command: named } = preview;
  let before: JournalEvent[];
  let beforeSourceIndexes: number[];
  try { ({ events: before, sourceIndexes: beforeSourceIndexes } = readJournalEvents(Journal.open(cwd, runId))); } catch (e) { return { ok: false, preview, refusal: (e as Error).message }; }
  const park = newestPark(before, named.taskId, beforeSourceIndexes);
  if (!park || park.index !== preview.park.index || park.line !== preview.park.line || park.kind !== preview.park.kind) {
    return { ok: false, preview, stale: true, refusal: `task ${named.taskId}'s park changed since preview (${park ? `now #L${park.line} ${park.kind ?? "unknown"}` : "no park now"}) — refresh and preview again` };
  }
  const released = before.slice(park.index + 1).find((e) => e.event === "task-approved" && e.taskId === named.taskId);
  if (released) {
    return { ok: false, preview, stale: true, refusal: `task ${named.taskId} was released at #L${beforeSourceIndexes[before.indexOf(released)]! + 1} by ${String(released.data.by ?? "unknown")} after this preview — no second decision appended; refresh` };
  }
  if (!permittedDecisionVerbs(park).includes(named.verb)) {
    return { ok: false, preview, refusal: `${named.verb} is not a decision for ${named.taskId}'s ${park.kind ?? "unknown"} park` };
  }
  // The argv that runs is rebuilt from the validated command; a preview whose argv says otherwise
  // (a permitted verb in `command`, a different flag in `argv`) is refused before any append.
  let argv: string[];
  try { argv = decisionArgv(named, { runId, by: preview.actor }); } catch (e) { return { ok: false, preview, refusal: (e as Error).message }; }
  if (argv.length !== preview.argv.length || argv.some((arg, i) => arg !== preview.argv[i])) {
    return { ok: false, preview, refusal: `preview argv [${preview.argv.join(" ")}] does not match the confirmed ${named.verb} [${argv.join(" ")}] — nothing appended` };
  }
  let message: string;
  try {
    message = await command(argv, cwd);
  } catch (e) {
    return { ok: false, preview, refusal: e instanceof Error ? e.message : String(e) };
  }
  let after: JournalEvent[];
  let afterSourceIndexes: number[];
  try { ({ events: after, sourceIndexes: afterSourceIndexes } = readJournalEvents(Journal.open(cwd, runId))); } catch (e) {
    return { ok: false, preview, refusal: `approve returned but the journal could not be read back: ${(e as Error).message}` };
  }
  const beforeLastSourceIndex = beforeSourceIndexes.at(-1) ?? -1;
  const gained = after
    .map((event, i) => ({ line: afterSourceIndexes[i]! + 1, sourceIndex: afterSourceIndexes[i]!, event }))
    .filter(({ sourceIndex }) => sourceIndex > beforeLastSourceIndex)
    .filter(({ event }) => event.event === "task-approved" && event.taskId === named.taskId);
  const appended = gained[0];
  if (gained.length !== 1 || !appended) {
    return { ok: false, preview, refusal: `approve returned "${message}" but the journal gained ${gained.length} task-approved row(s) for ${named.taskId} after #L${beforeLastSourceIndex + 1} — not shown as success` };
  }
  const release = typeof appended.event.data.release === "string" ? appended.event.data.release : undefined;
  const expected = {
    release: releaseForDecision(named.verb, park),
    by: preview.actor,
    reason: named.reason,
    via: "cli",
    gate: named.verb === "waive" ? park.failedGate : named.verb === "uphold" ? "review" : undefined,
    reviewRoundCeiling: named.reviewRounds,
  };
  const actual = {
    release,
    by: appended.event.data.by,
    reason: appended.event.data.reason,
    via: appended.event.data.via,
    gate: appended.event.data.gate,
    reviewRoundCeiling: appended.event.data.reviewRoundCeiling,
  };
  const mismatch = (Object.keys(expected) as (keyof typeof expected)[])
    .find((field) => actual[field] !== expected[field]);
  if (mismatch !== undefined) {
    return { ok: false, preview, refusal: `the appended decision at #L${appended.line} has ${mismatch} ${String(actual[mismatch] ?? "none")}, expected ${String(expected[mismatch] ?? "none")} for confirmed ${named.verb} — not shown as success` };
  }
  return {
    ok: true, preview, message, appended, release,
    disposition: approvalDispositionForRelease(release), run: approvalRunOwner(cwd, runId),
  };
}

/** The receipt: what the file gained, verified, and who enacts it — read after the write. */
export function decisionReceiptLines(receipt: DecisionReceipt): readonly string[] {
  const { preview } = receipt;
  if (!receipt.ok) {
    return [
      `refused      ${receipt.refusal}`,
      `task         ${preview.command.taskId} · park ${parkLine(preview.park)}`,
      `argv         tickmarkr approve ${preview.argv.map(quoteArg).join(" ")}`,
      "appended     nothing",
    ];
  }
  const appendedVerb: DecisionVerb = receipt.release === "gate-satisfied"
    ? "waive"
    : receipt.release === "review-upheld"
      ? "uphold"
      : receipt.release === "recheck"
        ? "recheck"
        : "approve";
  const appendedPark: NewestPark = receipt.appended.event.data.gate === undefined
    ? preview.park
    : { ...preview.park, failedGate: String(receipt.appended.event.data.gate) };
  return [
    `appended     #L${receipt.appended.line} task-approved ${preview.command.taskId} · release ${receipt.release ?? "none"} · disposition ${receipt.disposition} · read back from ${preview.journalFile}`,
    `run          ${preview.runId}`,
    `park         ${parkLine(preview.park)}`,
    `actor        ${String(receipt.appended.event.data.by)} · reason ${typeof receipt.appended.event.data.reason === "string" ? receipt.appended.event.data.reason : "none given"}`,
    `argv         tickmarkr approve ${preview.argv.map(quoteArg).join(" ")}`,
    ...consequenceLines(appendedVerb, appendedPark, receipt.release, receipt.disposition),
    ...enactmentLines(receipt.run, receipt.disposition),
    `state        ${receipt.run.live ? "pending daemon enactment" : "approved; resume required"} — permission recorded, no work dispatched, nothing green`,
    `command      ${receipt.message.split("\n")[0]}`,
  ];
}

/* ------------------------------------------------------------------------ */
/* The decision key grammar: a Actions → menu → Enter picks → y writes.      */
/* ------------------------------------------------------------------------ */

export interface DecisionMenu { readonly taskId: string; readonly verbs: readonly DecisionVerb[]; readonly selection: number }

/** Observable state of the decision flow. Every field is drawn; a state that cannot be drawn cannot exist. */
export interface DecisionSession {
  readonly menu: DecisionMenu | null;
  readonly confirming: DecisionPreview | null;
  readonly receipt: DecisionReceipt | null;
  readonly notice: string | null;
}

export const initialDecisionSession = (): DecisionSession => ({ menu: null, confirming: null, receipt: null, notice: null });

export interface DecisionKeyEvent { readonly input: string; readonly key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly return?: boolean; readonly escape?: boolean } }

export interface DecisionKeyResult {
  readonly session: DecisionSession;
  /** The verb picked from the menu — the caller previews it (a read) and stores the preview. */
  readonly open?: DecisionCommand;
  /** Present only when the confirm key landed on a preview — the one moment a write may happen. */
  readonly confirm?: DecisionPreview;
  /** True when this key was consumed by the decision flow. */
  readonly handled: boolean;
}

/**
 * The reducer never writes and never reads a file; it names commands. `a` opens the menu for the
 * selected park (a diagnostic park opens a menu with no verbs, stating why); ↑↓ move; Enter picks a
 * verb — which OPENS the confirm inset, never confirms; `y` on a confirm names the write; `n`/Esc
 * cancel the deepest layer. Enter on a confirm is inert by construction.
 */
export function applyDecisionKey(session: DecisionSession, event: DecisionKeyEvent, selected: RunDecision | undefined): DecisionKeyResult {
  if (session.confirming !== null) {
    if (event.input === "y") return { session: { ...session, confirming: null }, confirm: session.confirming, handled: true };
    if (event.input === "n" || event.key.escape === true) return { session: { ...session, confirming: null }, handled: true };
    return { session, handled: true };
  }
  if (session.menu !== null) {
    const { menu } = session;
    if (event.key.escape === true || event.input === "n") return { session: { ...session, menu: null }, handled: true };
    if (event.key.upArrow === true || event.key.downArrow === true) {
      const delta = event.key.upArrow === true ? -1 : 1;
      const selection = Math.max(0, Math.min(menu.verbs.length - 1, menu.selection + delta));
      return { session: { ...session, menu: { ...menu, selection } }, handled: true };
    }
    if (event.key.return === true) {
      const verb = menu.verbs[menu.selection];
      if (verb === undefined) return { session, handled: true };
      return { session: { ...session, menu: null }, open: { verb, taskId: menu.taskId }, handled: true };
    }
    return { session, handled: true };
  }
  if (event.input === "a") {
    if (selected === undefined) return { session: { ...session, notice: "no park selected — nothing to decide" }, handled: true };
    return { session: { ...session, menu: { taskId: selected.taskId, verbs: selected.verbs, selection: 0 }, receipt: null, notice: null }, handled: true };
  }
  return { session, handled: false };
}

/** Store the preview a picked verb produced — or its refusal as the notice. */
export function withDecisionPreview(session: DecisionSession, result: DecisionPreviewResult): DecisionSession {
  return result.ok ? { ...session, confirming: result.preview, notice: null } : { ...session, notice: result.refusal };
}

/** Store the receipt of the one write — a refusal is a receipt too, drawn as such. */
export function withDecisionReceipt(session: DecisionSession, receipt: DecisionReceipt): DecisionSession {
  return { ...session, receipt, confirming: null, notice: receipt.ok ? null : receipt.refusal };
}

/** The verbs the keybar may advertise for the current layer — nothing the flow cannot honour. */
export function decisionKeybar(session: DecisionSession, selected: RunDecision | undefined): string {
  if (session.confirming !== null) return `y Confirm ${session.confirming.command.verb} · n Cancel`;
  if (session.menu !== null) return session.menu.verbs.length === 0 ? "Esc Close" : "↑↓ Choose · Enter Preview · Esc Close";
  return selected === undefined ? "" : "a Actions";
}
