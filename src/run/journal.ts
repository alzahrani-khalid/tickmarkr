import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { channelKey, shq, TokenUsageSchema, type Assignment } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import { stateDirName, taskContentDigest, tickmarkrDir } from "../graph/graph.js";
import { GATE_NAMES, TIERS, type GateName, type Task, type TaskStatus } from "../graph/schema.js";
import { buildProfile, classify, type ProfileDiscount, type RoutingProfile } from "../route/profile.js";
import {
  DecisionEventSchema,
  trackJournalRows,
  type DecisionEvent,
  type DecisionEventWrite,
  type JournalSourceRow,
  type TrackedJournalRow,
} from "./protocol.js";
import { normalizeGateOutcome } from "./outcome.js";
import { redactSecrets } from "./redact.js";

export interface JournalEvent {
  ts: string;
  event: string;
  taskId?: string;
  data: Record<string, unknown>;
}

export type TaskPhase = "worker" | "gates" | `gate:${GateName}` | "judge" | "review" | "merge";

export function phaseForGate(gate: GateName): TaskPhase {
  if (gate === "acceptance") return "judge";
  if (gate === "review") return "review";
  return `gate:${gate}`;
}

/** The pipe projects the same normalized gate outcome as the TTY rail. The selected-test field only
 * chooses the held outcome's operator noun after the accessor has classified it; it is not a second
 * verdict read. */
const journalGateDetail = (data: Record<string, unknown>): string | undefined => {
  if (typeof data.gate !== "string") return undefined;
  switch (normalizeGateOutcome(data).kind) {
    case "passed":
      return `${data.gate} passed`;
    case "failed":
      return `${data.gate} failed`;
    case "held":
      return Array.isArray(data.selectedTests) ? `${data.gate} selected-test screen` : `${data.gate} held`;
    default:
      return data.gate;
  }
};

export function formatJournalNarration({ event, taskId, data }: JournalEvent): string {
  const assignment = data.assignment as Record<string, unknown> | undefined;
  const direct = [data.summary, data.reason, data.error, data.step, data.action, data.lint, data.branch, data.from]
    .find((value) => typeof value === "string" || typeof value === "number");
  const detail = Array.isArray(data.done)
    ? `done ${data.done.length}, failed ${Array.isArray(data.failed) ? data.failed.length : 0}`
    : typeof data.gate === "string"
      ? event === "tip-verify-failed"
        ? `${data.gate} failed${typeof data.lastMergedTask === "string" ? ` after ${data.lastMergedTask}` : ""}`
        : event === "tip-verify"
          ? `${data.gate} passed`
          : event === "gate-result"
            ? journalGateDetail(data)
            : `${data.gate}`
      : typeof data.code === "number" ? `exit ${data.code}`
        : typeof data.pid === "number" ? `pid ${data.pid}`
          : typeof data.baseRef === "string" ? `base ${data.baseRef.slice(0, 12)}`
            : direct === undefined
              ? typeof assignment?.adapter === "string" && typeof assignment.model === "string" ? `${assignment.adapter}:${assignment.model}` : undefined
              : String(direct);
  return [event, taskId, detail?.replace(/\s+/g, " ").slice(0, 120)].filter(Boolean).join(" — ");
}

// Phase 46 (RES-01/RES-02): per-task resume state derived from EXISTING journal events. A companion to
// the status replay (which is byte-untouched) — consumed by the daemon under resume:true (Phase 47) to
// re-seed execTask's loop-local attempt/tried/assignment state that otherwise dies with the process.
export interface ResumeState {
  attempts: number;
  tried: string[];
  lastAssignment?: Assignment;
  // OBS-189: set by a task-approved{release:review-upheld} replay — the upheld reviewer's findings,
  // carried into the next dispatch as the retry brief so the fix attempt knows what to fix.
  upheldFeedback?: string;
}

// T15: a gate result is reusable evidence, not operator authority. The daemon may reuse only the
// newest attempt's results and only while the task branch still carries the exact commit they name.
// `replaySatisfiedGates()` remains the separate OBS-130 authority fold for waiving a FAILED gate.
export interface CurrentAttemptGateReplay {
  commit: string;
  results: Map<GateName, boolean>;
}

// v1.71 OBS-119: run-wide channel exclusions derived from journal events — companion to
// replayResumeState(), consumed by the daemon on resume to re-seed demotedChannels.
export const CHANNEL_EXCLUSION_KINDS = ["dead-channel"] as const;
export type ChannelExclusionKind = (typeof CHANNEL_EXCLUSION_KINDS)[number];

// v1.24 OBS-18: explicit data on task-approved when the operator releases an attempt-cap park.
// Approve stamps this; replayResumeState zeros the attempt counter (fresh budget) while keeping
// tried (consult bans / burned channels). Absent on pre-v1.24 events ⇒ inert (corpus outcome-identical).
export const ATTEMPT_CAP_RELEASE = "attempt-cap" as const;
// OBS-130: task-approved carries the exact failed gate the operator satisfied. The release tag keeps
// ordinary humanGate and attempt-cap approvals byte-compatible while making this authority explicit.
export const GATE_SATISFIED_RELEASE = "gate-satisfied" as const;
// OBS-189: the second human decision a review park needs. `approve` (gate-satisfied) accepts the diff
// the reviewer rejected; `approve --uphold` sides WITH the reviewer and funds one fixed worker attempt
// carrying the findings — a park costs an attempt, never a fresh run that re-executes green tasks.
export const REVIEW_UPHELD_RELEASE = "review-upheld" as const;
// OBS-203: the third decision a gate-fail park needs. Plain approve WAIVES the failed gate (and every
// gate before it — daemon.ts remainingGates), which is wrong when the gate failed against a stale task
// DECLARATION rather than a bad diff: amend the spec's files[], recompile, and the gate now passes
// honestly. This release re-dispatches with the whole gate suite intact and no gate marked satisfied,
// so the corrected declaration is the thing that earns the green. Budget semantics match attempt-cap
// (fresh attempts, tried survives) because the park cost the task its remaining budget.
export const RECHECK_RELEASE = "recheck" as const;

export interface PreservedRef {
  ref: string;
  diffCommand: string;
}

// OBS-738: one authority for every recovery surface. The ref is accepted only from the row that
// preservation itself writes; task-human prose, branch heads and commit history are deliberately
// absent from this fold. Keep every row in journal order — one task can be recreated more than once,
// and the terminal record owes the operator every resulting recovery handle, not merely the newest.
export function preservedRefsByTask(events: JournalEvent[]): Map<string, PreservedRef[]> {
  const byTask = new Map<string, PreservedRef[]>();
  for (const event of events) {
    if (event.event !== "worktree-preserved" || !event.taskId || typeof event.data.ref !== "string"
        || event.data.ref === "") continue;
    const ref = event.data.ref;
    byTask.set(event.taskId, [
      ...(byTask.get(event.taskId) ?? []),
      { ref, diffCommand: `git diff ${shq(`${ref}^!`)}` },
    ]);
  }
  return byTask;
}

// OBS-189: review rounds are scoped to the current ENGAGEMENT — the stretch since the newest operator
// approval for the task. A whole-journal count re-parks an upheld task before its funded attempt can
// dispatch (measured live on run-20260726-213539), making a fresh journal the only escape. A T15
// replayMeasurement re-observes an interrupted round and is audit evidence, not a newly funded round.
export function reviewRoundsSinceApproval(events: JournalEvent[], taskId: string): number {
  let rounds = 0;
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    if (e.event === "task-approved") rounds = 0;
    else if (e.event === "gate-result" && e.data.gate === "review" && e.data.pass === false
             && e.data.replayMeasurement !== true) rounds++;
  }
  return rounds;
}

// OBS-189/OBS-254: the uphold brief is the operator's funded decision, not attempt state. ONE fold,
// two consumers — replayResumeState seeds it, and the daemon re-derives it from the journal at
// prompt-build time so no reset of attempt/channel state can take the findings with it (OBS-254 deleted
// the whole resume entry and dispatched a funded attempt with an empty "fix these specifically" heading).
export function upheldFeedbackByTask(events: JournalEvent[]): Map<string, string> {
  const upheld = new Map<string, string>();
  const lastReviewFail = new Map<string, string>(); // newest failed review details per task
  for (const e of events) {
    if (!e.taskId) continue;
    if (e.event === "gate-result" && e.data.gate === "review" && e.data.pass === false
        && typeof e.data.details === "string") {
      lastReviewFail.set(e.taskId, e.data.details);
    } else if (e.event === "gate-result" && e.data.gate === "review" && e.data.pass === true
               && e.data.skipped !== true) {
      // A later review pass settles the upheld finding. Retire both the active brief and the failed
      // verdict it came from so a still-later approval cannot resurrect already-settled feedback.
      upheld.delete(e.taskId);
      lastReviewFail.delete(e.taskId);
    } else if (e.event === "task-approved") {
      // any later approval supersedes: a plain accept-the-diff approval retires the uphold brief.
      if (e.data.release === REVIEW_UPHELD_RELEASE) {
        const details = lastReviewFail.get(e.taskId);
        if (details) upheld.set(e.taskId, details);
        else upheld.delete(e.taskId);
      } else {
        upheld.delete(e.taskId);
      }
    }
  }
  return upheld;
}

// v1.85 T3 (ruling R4 identity): one blocking finding, identified by CLASS + canonical PATH + stable
// SYMBOL. Line numbers are evidence, never identity — the same defect one line lower is the same
// finding. `note` keeps the reviewer's/judge's own bytes so the structure is additive, never lossy.
// A deferred review's rationale is verdict context, not identity: keeping it in its own field lets a
// reviewer revise the explanation without minting a second outstanding concern.
export interface StructuredFinding {
  class: string;
  path: string;
  symbol: string;
  note: string;
  rationale?: string;
  fingerprint: string;
}

// Reserved for a finding whose OWN evidence names no path. Reporting a blank path a reader would take
// for a resolved one is the silent-lie shape the gates exist to refuse, so the field says so outright.
export const UNIDENTIFIED = "<unidentified>";

const ANCHORED_RE = /^- (\S+?):(\d+) — (.*)$/;        // "## Anchored review" rows (llm.ts)
const REVIEW_ROW_START_RE = /^- \[([^\]\r\n]+)\] /gm; // "- [material] …" (review.ts)
const JUDGE_ROW_RE = /^✗ ([\w.-]+): (.*)$/;            // "✗ c1: …" (acceptance.ts) — id, then reason
const PATH_RE = /\b((?:[\w.@~+-]+\/)+[\w.@~+-]+\.\w{1,6})\b/;
const LINE_REF_RE = /(:\d+(?::\d+)?\b)|(\bline \d+\b)/gi;
const REVIEW_RATIONALE_SEPARATOR = " — rationale: ";

// ponytail: repo-relative tail from the first known top-level directory — enough to make an absolute
// worktree path and its repo-relative twin the same identity. Widen the marker list if a run ever
// names findings outside these roots.
function canonicalPath(raw: string): string {
  const cleaned = raw.replace(/^["'`(]+/, "").replace(/["'`),.]+$/, "").replace(/^\.\//, "");
  const m = /(?:^|\/)((?:src|tests|scripts|docs|fixtures|specs|schema|skills|assets)\/.+)$/.exec(cleaned);
  return m ? m[1]! : cleaned;
}

// The code identity a finding names, if it names one: a backticked identifier, then a call/member
// expression. Line references are stripped first so no identity can carry one. "" means the prose
// named no symbol — the caller decides what stands in, rather than this guessing from prose.
function identifierIn(note: string): string {
  const text = note.replace(LINE_REF_RE, " ");
  const ticked = /`([^`]{1,80})`/.exec(text);
  if (ticked) return ticked[1]!.trim();
  // no whitespace before the paren: "the brief (see …)" is prose, not a call expression, and a prose
  // word standing in for a symbol is the guessing this function exists to refuse.
  const call = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(/.exec(text);
  return call ? call[1]! : "";
}

// The SYMBOL of last resort. R4 admits "stable symbol/test title" — a finding whose prose names no
// code identity still has one stable identity of its own: its own words, with the volatile tokens
// swept out so line/path churn cannot mint a new symbol for the same finding. It is the reviewer's
// own bytes, never a guess, and it can never fuse two different findings into one.
function toFinding(cls: string, note: string, path: string, symbol: string, rationale?: string): StructuredFinding {
  const p = path || UNIDENTIFIED;
  const s = symbol || normalizeGateFailure(note) || UNIDENTIFIED;
  return {
    class: cls, path: p, symbol: s, note,
    ...(rationale !== undefined ? { rationale } : {}),
    fingerprint: `${cls}|${p}|${s}`,
  };
}

interface ReviewDetailFinding {
  label: string;
  note: string;
  rationale?: string;
}

/**
 * Decode review.ts's row rendering without treating physical lines as findings. A review finding's
 * note and rationale are JSON strings before rendering and may therefore contain newlines; the next
 * typed row (or the anchored-review block) is the record boundary. The fixed rationale separator is
 * removed before identity is computed, so changing only why a concern was accepted re-seats it.
 */
function reviewDetailFindings(details: string): ReviewDetailFinding[] {
  const anchoredAt = details.indexOf("\n\n## Anchored review");
  let prose = anchoredAt === -1 ? details : details.slice(0, anchoredAt);
  const inconsistencyAt = prose.search(/\nreview (?:finding|verdict) inconsistent:/);
  if (inconsistencyAt !== -1) prose = prose.slice(0, inconsistencyAt);
  const starts = [...prose.matchAll(REVIEW_ROW_START_RE)];
  return starts.map((start, i) => {
    const contentStart = start.index! + start[0].length;
    const contentEnd = starts[i + 1]?.index ?? prose.length;
    let content = prose.slice(contentStart, contentEnd);
    // The newline before the next typed row is framing, while every earlier newline belongs to the
    // reviewer's field. At EOF/anchored-review there is no framing newline to remove.
    if (starts[i + 1] && content.endsWith("\n")) content = content.slice(0, -1);
    const deferred = String(start[1]).startsWith("deferred/");
    const separatorAt = deferred ? content.indexOf(REVIEW_RATIONALE_SEPARATOR) : -1;
    return separatorAt === -1
      ? { label: start[1]!, note: content }
      : {
          label: start[1]!,
          note: content.slice(0, separatorAt),
          rationale: content.slice(separatorAt + REVIEW_RATIONALE_SEPARATOR.length),
        };
  });
}

/**
 * Structured findings for a BLOCKING review/judge gate result, parsed from the details the gate
 * already writes (D-03: no gate-module change, so an older gate's prose degrades to one unclassified
 * finding rather than to none). Never empty for a blocking result — a finding the journal cannot
 * classify is still a finding the next retry must not lose.
 *
 * Rule: a finding's path is its verdict row's own evidence path. An inline path and an anchored row's
 * path therefore resolve; a different anchor or the task's declared scope never substitutes for a
 * pathless finding. That row fails closed as UNIDENTIFIED instead of manufacturing an R4 identity.
 * A symbol the row's own prose does not name falls back to the criterion id, then to the row's own
 * normalized words (see toFinding).
 */
export function structuredFindings(gate: string, details: string, _scopeFiles: string[] = []): StructuredFinding[] {
  const lines = details.split("\n");
  const rows: StructuredFinding[] = [];
  const push = (cls: string, note: string, ownPath: string, fallbackSymbol = "", rationale?: string) => {
    const own = canonicalPath(ownPath || PATH_RE.exec(note)?.[1] || "");
    const sym = identifierIn(note) || fallbackSymbol;
    rows.push(toFinding(cls, note, own, sym, rationale));
  };
  if (gate === "review") {
    for (const finding of reviewDetailFindings(details)) {
      push(`review:${finding.label}`, finding.note, "", "", finding.rationale);
    }
  }
  for (const line of lines) {
    const a = ANCHORED_RE.exec(line);
    if (a) { push(`${gate}:anchored`, a[3]!, a[1]!); continue; }
    if (gate === "acceptance") {
      const j = JUDGE_ROW_RE.exec(line);
      // the criterion id IS a stable symbol for an unmet acceptance criterion — the same criterion is
      // the same finding however the judge rephrases its reason — so it backs the prose-derived one.
      if (j) { push("acceptance:unmet", j[2]!, "", j[1]!); continue; }
    }
  }
  if (rows.length === 0) {
    const head = lines.map((l) => l.trim()).find(Boolean) ?? "";
    push(`${gate}:unclassified`, head, "");
  }
  return rows;
}

// v2.1.5 T2: the reviewer's DEFERRAL channel, kept structured. `classifyReviewFindings`
// (gates/review.ts) renders a deferred finding as `- [deferred/<severity>] <note> — rationale: …`.
// The parser above preserves multiline fields and separates rationale from identity; an older journal
// whose row holds only prose still degrades through the same parse rather than to nothing. A deferred
// finding is a concern the reviewer SAW and chose not to block on; it is not a concern that was fixed.
const DEFERRED_CLASS_RE = /^review:deferred\b/;

export function isDeferredFinding(finding: StructuredFinding): boolean {
  return DEFERRED_CLASS_RE.test(finding.class);
}

/**
 * The findings a PASSING review DEFERRED — the rows a blocking-only projection drops on the floor.
 * A passing review's details are prose; without this the deferral has no identity a later round can
 * match, and every structured reader of the journal is blind to a defect the reviewer itself named.
 */
export function deferredReviewFindings(details: string): StructuredFinding[] {
  return structuredFindings("review", details).filter(isDeferredFinding);
}

/** The exact review.ts details fragment represented by a structured review finding. */
export function renderStructuredReviewFinding(finding: StructuredFinding): string {
  const label = finding.class.startsWith("review:") ? finding.class.slice("review:".length) : finding.class;
  const rationale = finding.rationale === undefined ? "" : `${REVIEW_RATIONALE_SEPARATOR}${finding.rationale}`;
  return `- [${label}] ${finding.note}${rationale}`;
}

// OBS-543/OBS-549: the shared, schema-free cross-run facts. They remain journal information — never
// graph status and never a gate predicate. `taskContentDigest` is intentionally repeated on each fact
// instead of adding a graph schema field or sidecar: it is the identity of the evidence, not task state.
export interface PriorRunJournal {
  runId: string;
  events: JournalEvent[];
}

export interface PriorFindingEvidence {
  runId: string;
  taskId: string;
  gate: "acceptance" | "review";
  taskContentDigest: string;
  finding: StructuredFinding;
}

export interface PriorMergeEvidence {
  runId: string;
  taskId: string;
  commit: string;
  taskContentDigest: string;
}

export interface PriorRunEvidence {
  findings: PriorFindingEvidence[];
  merges: PriorMergeEvidence[];
}

const findingRows = (event: JournalEvent, gate: "acceptance" | "review"): StructuredFinding[] => {
  if (Array.isArray(event.data.findings)) {
    const rows = event.data.findings.filter((finding): finding is StructuredFinding => {
      if (finding === null || typeof finding !== "object") return false;
      const row = finding as Record<string, unknown>;
      return typeof row.class === "string" && typeof row.path === "string"
        && typeof row.symbol === "string" && typeof row.note === "string"
        && (row.rationale === undefined || typeof row.rationale === "string")
        && typeof row.fingerprint === "string";
    });
    if (rows.length > 0) return rows;
  }
  // Compatibility for hand-written/additive journals: the daemon always emits `findings`, but a
  // digest-bound blocking row still has truthful evidence in details and must not vanish because its
  // optional structured projection was lost. Missing DIGEST remains fail-closed below.
  return typeof event.data.details === "string" ? structuredFindings(gate, event.data.details) : [];
};

/**
 * Pure chronological fold over already-bounded journals. Its retirement set is deliberately closed:
 * task completion or any ordinary approval retires prior findings; review-upheld retains them. A
 * dispatch failure, a later run-start, a pass, or a merge is inert. Completion is digest-scoped, so
 * proof for one version of a task cannot clear evidence for another version that reused the id.
 */
export function foldPriorEvidence(runs: readonly PriorRunJournal[]): PriorRunEvidence {
  const unresolved = new Map<string, PriorFindingEvidence>();
  const merges: PriorMergeEvidence[] = [];
  const clearTask = (taskId: string, digest?: string) => {
    for (const [key, evidence] of unresolved) {
      if (evidence.taskId === taskId && (digest === undefined || evidence.taskContentDigest === digest)) {
        unresolved.delete(key);
      }
    }
  };

  for (const run of runs) {
    // task-done immediately precedes merge in daemon journals. This per-run association lets the
    // existing merge row stay byte-compatible while the stamped completion supplies its task identity.
    const completedDigest = new Map<string, string>();
    for (const event of run.events) {
      const taskId = event.taskId;
      if (!taskId) continue;
      if (event.event === "task-approved") {
        if (event.data.release !== REVIEW_UPHELD_RELEASE) clearTask(taskId);
        continue;
      }
      if (event.event === "task-done") {
        const digest = event.data.taskContentDigest;
        if (typeof digest === "string") {
          clearTask(taskId, digest);
          completedDigest.set(taskId, digest);
        } else {
          completedDigest.delete(taskId);
        }
        continue;
      }
      if (event.event === "merge") {
        const digest = completedDigest.get(taskId);
        const commit = event.data.commit;
        if (digest && typeof commit === "string" && /^[0-9a-f]{40}$/i.test(commit)) {
          merges.push({ runId: run.runId, taskId, commit, taskContentDigest: digest });
        }
        continue;
      }
      const gate = event.data.gate;
      const digest = event.data.taskContentDigest;
      if (event.event !== "gate-result" || event.data.pass !== false || event.data.skipped === true
          || (gate !== "acceptance" && gate !== "review") || typeof digest !== "string") continue;
      for (const finding of findingRows(event, gate)) {
        const evidence: PriorFindingEvidence = {
          runId: run.runId, taskId, gate, taskContentDigest: digest, finding,
        };
        unresolved.set(`${taskId}\0${digest}\0${finding.fingerprint}`, evidence);
      }
    }
  }
  return { findings: [...unresolved.values()], merges };
}

/** One rendering shared verbatim by compile diagnostics and the fresh worker's feedback seam. */
export function formatPriorFindingEvidence(evidence: PriorFindingEvidence): string {
  return `Prior-run EVIDENCE (not a verdict) from ${evidence.runId} ${evidence.gate}: ${evidence.finding.note}`;
}

// v1.85 T3: volatile tokens carry no information about WHY a gate failed — ~663m across 5 runs went to
// re-dispatching against failures that differed only in these. Every rule below erases a token PROVEN
// to be a diagnostic location or a clock reading; nothing erases a value the failure asserts ABOUT.
// Ordered: styling, then timestamps (they contain colon-digits), then paths (they end before a :line),
// then line refs, durations, long hex.
const VOLATILE_TOKENS: Array<[RegExp, string]> = [
  [/\u001b\[[0-9;]*[a-zA-Z]/g, ""],                                            // ANSI styling
  [/\b\d{4}-\d{2}-\d{2}[T ][\d:]+(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>"], // timestamps
  [/\brun-\d{8}-\d{6}(?:-\d{16})?\b/g, "<run>"],                              // run identifiers
  [/\b0x[0-9a-fA-F]+\b/g, "<addr>"],                                            // memory addresses
  // An absolute path INTO the repo keeps its repo-relative tail — that tail IS identity (a defect in
  // daemon.ts is not a defect in journal.ts); only the machine/worktree prefix ahead of it is volatile.
  [/\/(?:[\w.@~+%-]+\/)*((?:src|tests|scripts|docs|fixtures|specs|schema|skills|assets)\/[\w.@~+%/-]+)/g, "<path>/$1"],
  // v1.88 T3: a mkdtemp directory name is a chosen prefix plus six characters the RUNTIME generates,
  // and the final-segment rule below keeps the whole name as identity — so a failure that NAMES the
  // temp directory carried its random suffix through, two dispatches of one defect fingerprinted
  // apart, and gate-fingerprint-cap was unreachable (v1.87 T5 re-ran six times where the cap would
  // have parked it at two). Only the generated suffix is volatile; the chosen prefix is identity —
  // a tickmarkr-llm- failure is not a tickmarkr-eval- one and must not spend its retry budget.
  // Gated three ways, because a false cap bans a legitimate retry while a missed cap costs one round:
  // on a tmp ROOT (mkdtemp writes under os.tmpdir()), on the separator that ends the chosen prefix
  // (it is what tells us where the prefix stops), and on the suffix carrying an uppercase or a digit
  // so an ordinary six-letter word — /tmp/tickmarkr-worker-output — stays identity.
  [/(\/(?:private\/)?(?:tmp|var\/folders)\/(?:[\w.@~+%-]+\/)*?[\w.@~+%-]*[-_])(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6}(?![\w.@~+%-])/g, "$1<tmp>"],
  // Rule: an absolute diagnostic path's machine/worktree prefix is volatile, but its named file is
  // identity. Therefore paths outside the repo-marker set keep their final segment: two machines
  // naming parse.js normalize together, while parse.js and render.js can never spend one another's
  // retry budget. A path-shaped VALUE ("/api/v1/users") is rooted nowhere real and survives.
  [/\/(?:tmp|private|var|Users|home|opt|workspace|w)(?:\/[\w.@~+%-]+)*\/([\w.@~+%-]+)\/?/g, "<path>/$1"],
  // A line[:col] ref counts as one only when it hangs off a file-ish token (a dot or a slash in it):
  // R4 says the line number is evidence, not identity. "exit 1" and "expected 3" are neither.
  [/([\w.@~+%-]*[./][\w.@~+%-]*):\d+(?::\d+)?\b/g, "$1:<line>"],
  [/\bline \d+\b/gi, "line <line>"],
  [/\b\d+(?:[.,]\d+)?\s?(?:ms|µs|us|ns|s|sec|secs|m|min|mins|h|hrs)\b/g, "<dur>"], // durations
  [/\b[0-9a-f]{12,40}\b/g, "<hex>"],                                            // sha / worktree ids
];

// Rule: a quoted span is protected IFF it is assertion payload. Quoting alone is ordinary diagnostic
// rendering, so paths/timestamps inside ENOENT and worker messages still normalize. A value introduced
// by an assertion cue is payload whether quoted or bare: `expected /tmp/actual-a to be /tmp/want-a`
// must not collapse with an assertion about actual-b.
//
// The asymmetry is deliberate: a missed cap costs one extra round, a false cap bans a legitimate retry.
const ASSERTION_CUE = "expected|received|actual|got|to be|to equal|to match|to contain|instead of|but was|but got|but received";
const PAYLOAD_SPAN = new RegExp(
  `(?<=\\b(?:${ASSERTION_CUE})[:=]?[ \\t])(?:'[^'\\n]*'|"[^"\\n]*"|\`[^\`\\n]*\`|[^\\s,;)]+)`,
  "gi",
);

const eraseVolatile = (text: string) =>
  VOLATILE_TOKENS.reduce((out, [re, replacement]) => out.replace(re, replacement), text);

// Whitespace RUNS are rendering, so they collapse — but only outside a payload, exactly like every
// other rule here. Inside one it is part of what the failure asserts: `expected "a  b"` and
// `expected "a b"` are two different assertions, and collapsing the joined string erased that
// difference and banned a retry that was never redundant. Newlines survive (payload spans cannot
// cross one) and the line-wise trim below finishes the job.
const collapseRuns = (text: string) => text.replace(/[^\S\n]+/g, " ");

// v1.85 T34: the runner's TALLY moves with the base, not with the defect. When another task merges
// ahead and adds test files, vitest re-counts the suite — `192 passed (197)` becomes `193 passed
// (198)` — while the FAIL headlines name the same defect in the same order, so a substantively
// identical gate failure re-fingerprinted and gate-fingerprint-cap never counted the repeat
// (measured on T21 in run-20260805-164546: details at 17:33:02 and 18:11:01 differ only so).
//
// Why provenance AND shape, and why not digits as a class: a blanket \d+ collapse also erases counts
// that ARE identity — the failed-assertion count, the failing-suite count, an exit status, an error
// code — and the rule above governs: a missed cap costs one extra round, a false cap bans a
// legitimate retry. So the mask is gated on PROVENANCE first: only lines inside the `failing tests:`
// block baseline.ts:209-219 emits (up to its blank-line/`new failure fingerprints` boundary) are
// eligible, which keeps review prose, quoted diffs and assertion payloads structurally unreachable —
// and that block's own `FAIL … > test name` headlines are excluded by SHAPE: only a line that starts
// with the runner's own `Tests`/`Test Files` summary token is a tally line.
//
// Masked tally FIELDS, exactly: the passed count, the skipped and todo counts, and the derived
// parenthesized total immediately following the tally sequence. Deliberately KEPT (a reader uses
// each of them to tell two failures apart): every `N failed` count on the line (which suites and how
// many assertions actually broke — the defect's identity), everything after the derived total (an
// appended `| exit 1`, an appended `(404)` code), and every other number anywhere.
const RUNNER_TALLY_LINE =
  /^([ \t]*(?:Test Files|Tests)[ \t]+)((?:\d+ (?:failed|passed|skipped|todo)[ \t]*\|[ \t]*)*\d+ (?:failed|passed|skipped|todo))([ \t]*\(\d+\))?(.*)$/;
const TALLY_MOVED_FIELD = /\d+ (?=passed|skipped|todo)/g;

const maskTallyLine = (line: string): string => {
  const m = RUNNER_TALLY_LINE.exec(line);
  if (!m) return line;
  const fields = m[2]!.replace(TALLY_MOVED_FIELD, "#");
  const total = (m[3] ?? "").replace(/\d+/, "#");
  return m[1]! + fields + total + m[4]!;
};

// Computed on the FULL details text BEFORE any payload split: every recorded tally-bearing detail
// carries the `failing tests:` header, so gating on it closes the false-line-start axis (the mask
// never sees a slice boundary) and the wrong-provenance axis in one place.
const maskRunnerTallies = (text: string): string => {
  let inBlock = false;
  return text
    .split("\n")
    .map((line) => {
      if (!inBlock) {
        if (line.trim() === "failing tests:") inBlock = true;
        return line;
      }
      if (line.trim() === "" || line.startsWith("new failure fingerprints")) {
        inBlock = false;
        return line;
      }
      return maskTallyLine(line);
    })
    .join("\n");
};

/** Normalized identity of a gate failure: the same defect, seen twice, normalizes to the same bytes. */
export function normalizeGateFailure(details: string): string {
  const masked = maskRunnerTallies(details);
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(PAYLOAD_SPAN)) {
    out += collapseRuns(eraseVolatile(masked.slice(last, m.index))) + m[0];
    last = m.index + m[0].length;
  }
  out += collapseRuns(eraseVolatile(masked.slice(last)));
  return out.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

// Two normalized-identical failures of one gate on one task buy no more rounds (the ladder cannot fix
// what it already re-ran verbatim). Engagement-scoped exactly like reviewRoundsSinceApproval: an
// operator approval is a new engagement, and nothing else resets the count. Resume re-measurements
// are excluded because the interrupted attempt already bought the result they confirm.
export const GATE_FINGERPRINT_CAP = 2;

export function identicalGateFailures(events: JournalEvent[], taskId: string, gate: string, normalized: string): number {
  let n = 0;
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    if (e.event === "task-approved") n = 0;
    else if (e.event === "gate-result" && e.data.gate === gate && e.data.pass === false
             && e.data.replayMeasurement !== true
             && typeof e.data.details === "string"
             && normalizeGateFailure(e.data.details) === normalized) n++;
  }
  return n;
}

/** Repair attempts this engagement has already funded — journal-derived, so a resume inherits it. */
export function repairsSinceApproval(events: JournalEvent[], taskId: string): number {
  let n = 0;
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    if (e.event === "task-approved") n = 0;
    else if (e.event === "repair-attempt") n++;
  }
  return n;
}

// Both retry decisions below govern exactly ONE dispatch: the next one. So both are read back from the
// journal at the moment that dispatch is built, never carried in a process variable — a stop between
// the decision and the dispatch (OBS-254's shape, one layer up) would otherwise send a normal prompt
// with the findings gone, or re-run an assignment that was banned.
//
// Rule: retry state is spent iff a worker actually launches. The expiry is `worker-launch`, NOT
// `task-dispatch`: task-dispatch is journaled before worktree
// recreation, setup, prompt writing and slot allocation, so spending the decision there hands it to a
// dispatch that may still die before any worker sees it — and `--retry-failed` would then send a fresh
// prompt with the repair findings gone, or re-run the banned channel. worker-launch is appended only
// once the prompt has actually been delivered to a worker, which is the dispatch the decision governs.
const DECISION_SPENT = "worker-launch";

function decisionForNextDispatch(events: JournalEvent[], taskId: string, event: string): JournalEvent | undefined {
  let pending: JournalEvent | undefined;
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    if (e.event === event) pending = e;
    else if (e.event === DECISION_SPENT) pending = undefined;
  }
  return pending;
}

/**
 * Why the last attempt failed, one row per journaled cause, in the daemon's own `source: details`
 * shape. The daemon builds that brief in a loop-local variable, which dies with the process: a resumed
 * or `--retry-failed` run rebuilt the prompt from nothing and dispatched a retry that had lost the
 * reason it was retrying — OBS-254's class, one layer below the upheld brief. Re-derived here so the
 * bytes the journal already holds cannot be taken away by any reset of attempt or channel state.
 *
 * The same rule governs a dead DISPATCH: its exact task-failed error is retained until
 * `worker-launch`, never retired at
 * `task-dispatch`: everything between the two — worktree recreation, setup, prompt write, slot
 * allocation, the launch itself — can still die with no worker having read a word, and clearing at
 * task-dispatch meant `--retry-failed` after exactly that death rebuilt the prompt without the gate
 * failures OR the delivery failure that preceded it. `task-approved` also clears (an operator approval
 * retires the findings it settled — the uphold case re-derives its own brief separately).
 */
export function journaledFailureBrief(events: JournalEvent[], taskId: string): string[] {
  let rows: string[] = [];
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    if (e.event === "worker-launch" || e.event === "task-approved") rows = [];
    else if (e.event === "gate-result" && e.data.pass === false && e.data.skipped !== true
             && typeof e.data.details === "string") rows.push(`${e.data.gate}: ${e.data.details}`);
    else if (e.event === "delivery-readiness-failed" && typeof e.data.transcript === "string") {
      rows.push(`dispatch: delivery readiness failed after ${e.data.waitedMs}ms; pane transcript:\n${e.data.transcript}`);
    } else if (e.event === "task-failed" && e.data.kind === "dispatch" && typeof e.data.error === "string") {
      rows.push(`dispatch: ${e.data.error}`);
    }
  }
  return rows;
}

/**
 * T6: the review findings still OUTSTANDING on a task. A review finding is a property of the TASK,
 * not of the attempt that drew it: it stays outstanding until a later review PASSES on the task (or
 * an operator approval settles it), and it therefore travels on EVERY dispatch until then.
 *
 * The two carries beside this one are attempt-scoped by construction and both lose it. The funded
 * repair (`pendingRepairFindings`) is spent at the next `worker-launch` and is budgeted at two per
 * engagement; `journaledFailureBrief` is reset at that same launch, so it hands the next brief only
 * the LAST attempt's bytes. The moment one attempt fails for an unrelated reason — a red build, a
 * refused tree, or a death that produces no verdict at all and journals no gate row whatsoever — the
 * outstanding finding is in neither carry, and the run re-derives the task from the spec and lands on
 * the same gap the reviewer already anchored.
 *
 * Retirement is closed and narrow: a review that PASSED, or the one approval that accepts the review
 * gate itself (`GATE_SATISFIED_RELEASE` stamped `gate: "review"` — the operator taking the diff the
 * reviewer rejected). Every other approval RETAINS. `--uphold` funds an attempt to FIX the findings;
 * `--recheck` and an attempt-cap release fund another dispatch and say nothing about the reviewer's
 * objection; a plain human-gate approval predates any review; a gate-satisfied release naming some
 * other gate settled that gate, not this one. Reading "approved" as "settled" is how a still-open
 * finding was dropped at the exact moment the operator paid for another attempt to fix it. A review
 * that DECLINED (`skipped`) is not a verdict and neither adds nor retires — fail closed. Findings are
 * keyed by fingerprint, so a reviewer restating one across rounds carries it once, not once per round.
 *
 * v2.1.5 T2: a passing review settles the findings it BLOCKED on. It does not settle the ones it
 * DEFERRED — those it saw, declined to block on, and recorded a rationale for, and nothing has fixed
 * them. So a pass retires the blocking set and re-seats its own deferrals, and the two retirements
 * stay distinguishable: the blocking finding is gone, the deferral travels on as accepted work.
 *
 * A deferral's bound is the SAME single release as a blocking finding's — the operator accepting the
 * review gate itself (`GATE_SATISFIED_RELEASE` stamped `gate: "review"`), the one approval in which a
 * human actually looked at what the reviewer waved through. It is deliberately NOT bounded by a round
 * count or by a time window: both retire a finding by arithmetic nobody read, which is the silent drop
 * this fold exists to refuse. Nor can it accumulate — a reviewer restating the same path/note round
 * after round re-seats ONE fingerprint, and a revised rationale replaces the prior rationale on that
 * row. N rounds of the same concern therefore carry the newest accepted explanation once, not N rows.
 */
export function outstandingReviewFindings(events: JournalEvent[], taskId: string): StructuredFinding[] {
  const open = new Map<string, StructuredFinding>();
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    if (e.event === "task-approved") {
      if (e.data.release === GATE_SATISFIED_RELEASE && e.data.gate === "review") open.clear();
      continue;
    }
    if (e.event !== "gate-result" || e.data.gate !== "review" || e.data.skipped === true) continue;
    if (e.data.pass !== false) {
      // a later review PASSED on this task: every finding it BLOCKED on is settled …
      for (const [key, finding] of open) if (!isDeferredFinding(finding)) open.delete(key);
      // … and no deferral is, whether or not this pass restated it. A pass is silent about a
      // deferral it does not mention: the concern is unfixed either way, and the reviewer that
      // waved it through is not the release that accepts it. Retiring on omission would drop it on
      // the very next round — the same silent drop by a different door.
      for (const finding of findingRows(e, "review").filter(isDeferredFinding)) open.set(finding.fingerprint, finding);
    } else for (const finding of findingRows(e, "review")) open.set(finding.fingerprint, finding);
  }
  return [...open.values()];
}

/** The findings a funded repair must carry into the next dispatch, or undefined if none is pending. */
export function pendingRepairFindings(events: JournalEvent[], taskId: string): string | undefined {
  const e = decisionForNextDispatch(events, taskId, "repair-attempt");
  return typeof e?.data.findings === "string" ? e.data.findings : undefined;
}

/**
 * The gate whose identical failure banned an identical retry of the NEXT dispatch — bound to the
 * channel that produced it, so a verdict that has already moved the work elsewhere is not refused for
 * a channel it is no longer using, and a later unrelated failure is not parked under a stale reason.
 */
export function activeRetryBan(events: JournalEvent[], taskId: string, channel: string): string | undefined {
  const e = decisionForNextDispatch(events, taskId, "gate-fingerprint-cap");
  return e && e.data.channel === channel && typeof e.data.gate === "string" ? e.data.gate : undefined;
}

// Fail-closed shape for a dispatched assignment (journal.ts:75-90 posture): a malformed assignment in
// one dispatch degrades that single task toward today's behavior — counts toward attempts, contributes
// nothing to tried, poisons only lastAssignment — never crashes resume, never poisons other tasks.
const DispatchAssignmentSchema = z.object({
  adapter: z.string(),
  model: z.string(),
  channel: z.enum(["sub", "api"]),
  tier: z.enum(TIERS),
});

// OBS-547: "authoring" is a scope red every one of whose offenders the collateral map had already
// named — a missing files[] line, not a worker quality failure. It is deliberately absent from the
// routing profile's QUALITY_FAIL_PARKS (route/profile.ts): the channel did nothing wrong.
export const PARK_KINDS = ["human-gate", "ladder-exhausted", "attempt-cap", "gate-fail", "quota",
  "reroute-exhausted", "setup", "stall", "merge-conflict", "tip-moved", "infra", "dispatch",
  "authoring"] as const;
export type ParkKind = (typeof PARK_KINDS)[number];
// v1.85 T3: "repair" is a third dispatch mode beside the v1.29 session pair — a fix-only attempt that
// carries the failing findings and the diff CONTENT of the work already landed, instead of re-buying
// ~20m of onboarding to rediscover them (62 of 68 measured re-dispatches were fresh).
export const RETRY_MODES = ["resume", "fresh", "repair"] as const;
export type RetryMode = (typeof RETRY_MODES)[number];

// OBS-548: "dead-channel" is the fourth conflation OBS-53 opened, named. The dead-channel fast-kill
// concludes a worker while the rolling stall window still has most of its time left, so labelling it
// stall-timeout points every downstream reader — the repair brief, the consult — at a mechanism that
// cannot have fired.
export const WORKER_RESULT_CAUSES = ["provider-death", "dead-channel", "stall-timeout", "malformed-trailer", "clean-exit-no-trailer"] as const;
export type WorkerResultCause = (typeof WORKER_RESULT_CAUSES)[number];

// Status consumes the routing profile's existing quality split directly: verified park kinds classify
// to 0, while availability/recovery noise classifies to null. Keep the synthetic row here at the
// run↔route seam so presentation code never grows a second list of "bad" park kinds.
export function isQualityFailureParkKind(kind: ParkKind): boolean {
  return classify({
    shape: "", adapter: "-", model: "-", channel: "-", attempts: 0,
    outcome: "human", durationMs: 0, parkKind: kind,
  }) === 0;
}

// OBS-206: ONE classification rule, called at write time by the daemon's failure handler and at read
// time by `resume --retry-failed`, so the two can never drift and a label written by an older binary
// can never outvote the evidence sitting in the same journal. `taskEvents` is this task's events up to
// (not including) the failure. The gate evidence is scoped to the CURRENT attempt: a whole-history
// scan asks "did this task EVER fail a gate", which mislabels an infra death as a verified failure for
// any task that ever failed one gate — and, since only "dispatch" is retryable, locks it out forever.
export function classifyTaskFailure(taskEvents: JournalEvent[]): ParkKind {
  let dispatchIdx = -1;
  for (let i = taskEvents.length - 1; i >= 0; i--) {
    if (taskEvents[i]!.event === "task-dispatch") { dispatchIdx = i; break; }
  }
  if (dispatchIdx < 0) return "infra"; // never dispatched — nothing to retry
  return taskEvents.slice(dispatchIdx + 1)
    .some((e) => e.event === "gate-result" && e.data.pass === false) ? "gate-fail" : "dispatch";
}

// The newest terminal event owns the cause. Unknown/malformed kinds fail toward undefined so a
// task-failed row keeps the legacy red treatment instead of being mistaken for recoverable noise.
export function recordedTaskFailureKind(events: JournalEvent[], taskId: string): ParkKind | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.taskId !== taskId || (e.event !== "task-human" && e.event !== "task-failed")) continue;
    // A park kind is a daemon DECISION and is read exactly as recorded. A failure kind is a
    // CLASSIFICATION over evidence that is still in this journal, so it is re-derived (OBS-206) —
    // recomputation agrees with every correctly-written label and repairs the wrong ones in place.
    if (e.event === "task-failed") {
      return classifyTaskFailure(events.slice(0, i).filter((x) => x.taskId === taskId));
    }
    return typeof e.data.kind === "string" && (PARK_KINDS as readonly string[]).includes(e.data.kind)
      ? e.data.kind as ParkKind
      : undefined;
  }
  return undefined;
}

// Runs can end and later resume in the same journal. The newest lifecycle marker decides whether
// an unresolved task is still recoverable by this live daemon or belongs to an ended run.
export function runHasEnded(events: JournalEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!.event;
    if (event === "run-end" || event === "superseded") return true;
    if (event === "run-start" || event === "run-resume") return false;
  }
  return false;
}

// OBS-53: provider-outage signatures in dead worker output ("Unable to reach the model provider" and kin).
const PROVIDER_OUTAGE_RE = /Unable to reach the model provider|cannot reach the model provider|model provider.*(?:unavailable|unreachable)/i;

/** OBS-53: classify worker-result failures so retries and routing see the true signal, not one lumped bucket. */
export function classifyWorkerResultCause(opts: {
  output: string;
  ok: boolean;
  finished: boolean;
  exitCode: number | null;
  summary: string;
  timedOut: boolean;
  /** OBS-548: the daemon's dead-channel fast-kill ended this attempt, not the rolling stall window. */
  deadChannel?: boolean;
}): WorkerResultCause | undefined {
  if (opts.ok && opts.finished) return undefined;
  // v1.89 T7: a provider-outage signature is independent of trailer state and has its own remedy.
  if (PROVIDER_OUTAGE_RE.test(opts.output)) return "provider-death";
  // OBS-548: the fast-kill is its own mechanism and outranks every trailer-derived field below —
  // those all bottom out in stall-timeout, which is the one thing this death is NOT.
  if (opts.deadChannel) return "dead-channel";
  // A stall kill is distinguished by its timeout signal, before any trailer-derived result fields.
  if (opts.timedOut) return "stall-timeout";
  if (opts.summary === "unparseable TICKMARKR_RESULT trailer") return "malformed-trailer";
  if (!opts.finished && opts.exitCode !== null) return "clean-exit-no-trailer";
  if (!opts.finished) return "stall-timeout";
  return undefined;
}

export const TelemetryRowSchema = z.object({
  // v1.5 core — required; every old row has all eight (daemon.ts writes all eight)
  taskId: z.string(), shape: z.string(), adapter: z.string(), model: z.string(), channel: z.string(),
  attempts: z.number(), outcome: z.enum(["done", "failed", "human"]), durationMs: z.number(),
  // v1.6 additive (TEL-01/02) — OPTIONAL: a v1.5 row parses with these === undefined ("unobserved"),
  // never false/0. Phase 12 readers must branch on === true / === false; `?? false` is the poisoning bug.
  firstAttemptOk: z.boolean().optional(),
  gateFails: z.number().optional(),
  consults: z.number().optional(),
  parkKind: z.enum(PARK_KINDS).optional(),
  // v1.7 additive (SPEND-02) — OPTIONAL: absent = unmetered, never 0. .catch(undefined): a MALFORMED
  // tokens sub-object degrades to unmetered instead of safeParse-dropping the whole row — a metering
  // bug must never remove a row from profile derivation (that would let metering perturb routing).
  tokens: TokenUsageSchema.optional().catch(undefined),
  // v1.7 (SPEND-02): count of attempts that produced a usage record. Present IFF tokens is present.
  // meteredAttempts < attempts ⇒ tokens is a FLOOR (partially metered task) — Phase 18 must label it,
  // never print it as a total. Absent ⇒ the row is unmetered entirely.
  meteredAttempts: z.number().int().positive().optional().catch(undefined),
  // v1.8 additive (TEL-05) — OPTIONAL, z.literal(true) so `false` is UNREPRESENTABLE: absent = "no
  // mid-task quota failover observed" (never false), present = attributed to the channel throttled
  // away FROM. Phase 26 ROUTE-12 (utilization axis) consumes this; only the if(next) branch writes it.
  quotaFailover: z.literal(true).optional(),
  // v1.13 additive (ROUTE-18) — OPTIONAL, z.literal(true) so `false` is UNREPRESENTABLE: absent = "no
  // overrun observed" (never false), present = the channel burned a window without emitting a trailer
  // (worker-result ok:false, finished:false — no-trailer timeout OR trailer-less crash-exit). Written
  // only at the daemon's !finished site (after the quota check, quota-disjoint); 48-01's ProfileRow
  // (src/route/profile.ts) consumes the field-name contract `overrun`. Mirrors quotaFailover exactly.
  overrun: z.literal(true).optional(),
  // v1.29 additive: mode of the attempt represented by this row. Absent on old telemetry.
  retryMode: z.enum(RETRY_MODES).optional(),
  // v1.46 additive (T5): gate-signal quality for routing hygiene — OPTIONAL, absent = legacy (0.25 at fold).
  signalQuality: z.union([z.literal(0), z.literal(0.25), z.literal(0.5), z.literal(0.75), z.literal(1)]).optional(),
  signalBasis: z.enum(["proved", "review-agree", "judge-only", "legacy", "vacuous", "skipped"]).optional(),
  // OBS-132 additive judge invocation rows. Absent means the legacy per-task row. Judge rows reuse the
  // required v1.5 envelope so per-run raw readers stay source-compatible, while readAllTelemetry filters
  // them before profile derivation: verdict production must be observable without becoming worker reward.
  kind: z.literal("judge").optional(),
  judgeOutcome: z.enum(["parseable", "unparseable"]).optional(),
});
export type TelemetryRow = z.infer<typeof TelemetryRowSchema>;

export interface JudgeInvocationEvidence {
  taskId: string;
  channel: string;
  outcome: "done" | "failed";
  judgeOutcome: "parseable" | "unparseable";
  durationMs: number;
  transcript?: string;
}

interface JudgePersistenceContext {
  invocations: JudgeInvocationEvidence[];
  written: boolean;
}

const judgePersistence = new AsyncLocalStorage<JudgePersistenceContext>();

// run-gates scopes this context around the existing daemon onGate callback. Journal.append therefore
// remains the sole persistence boundary: it can enrich the existing judge-retry row and write invocation
// telemetry without requiring a parallel daemon callback or changing healthy gate-result payloads.
export function withJudgeInvocationEvidence<T>(
  invocations: JudgeInvocationEvidence[],
  persist: () => Promise<T>,
): Promise<T> {
  return judgePersistence.run({ invocations, written: false }, persist);
}

// v1.46 T5 (Sol signal telemetry): gate-result rows carry explicit signalQuality so future defect windows
// are identifiable without forensics. Basis is the provenance claim; quality is the dyadic h-fold weight.
export const SIGNAL_BASIS = ["proved", "review-agree", "judge-only", "legacy", "vacuous", "skipped"] as const;
export type SignalBasis = (typeof SIGNAL_BASIS)[number];

export const SIGNAL_QUALITY: Record<SignalBasis, 0 | 0.25 | 0.5 | 0.75 | 1> = {
  proved: 1,
  "review-agree": 0.75,
  "judge-only": 0.5,
  legacy: 0.25,
  vacuous: 0,
  skipped: 0,
};

export function signalQualityFromBasis(basis: SignalBasis): 0 | 0.25 | 0.5 | 0.75 | 1 {
  return SIGNAL_QUALITY[basis];
}

export function deriveSignalBasis(
  gate: string, pass: boolean, details: string, meta: Record<string, unknown> = {},
): SignalBasis {
  if (meta.skipped === true) return "skipped";
  if (meta.unparseable === true) return "vacuous";
  if (gate === "acceptance") return "judge-only";
  if (gate === "review") return pass ? "review-agree" : "vacuous";
  if (gate === "test" || gate === "build") {
    if (!pass) return "vacuous";
    if (/no test files|0 tests|tests\s+0\s/i.test(details)) return "vacuous";
    return "proved";
  }
  return pass ? "proved" : "vacuous";
}

// The canonical gate-result journal payload — daemon should spread this into append("gate-result", …).
export function gateResultJournalData(
  gate: string, pass: boolean, details: string, meta: Record<string, unknown> = {},
): { gate: string; pass: boolean; details: string; signalBasis: SignalBasis; signalQuality: number } & Record<string, unknown> {
  const signalBasis = deriveSignalBasis(gate, pass, details, meta);
  return { gate, pass, details, ...meta, signalBasis, signalQuality: signalQualityFromBasis(signalBasis) };
}

// T3 (Sol #2 / Fable F2): one canonical engagement identity, shared by status AND resume. The run-start
// event records graphDefinitionHash (over compiled task definitions only — see graph.graphDefinitionHash);
// this is the single field both consumers read, and the single comparator below is the single place the
// journal↔graph join is decided. unbound (no recorded definition hash, e.g. a pre-v1.44 journal) and
// mismatch are both not-comparable — status renders the notice either way; resume refuses either way and
// distinguishes the reason only for its message and the --graph-changed release event.
export function recordedGraphDefinitionHash(events: JournalEvent[]): string | undefined {
  for (const e of events) {
    if (e.event === "run-start" && typeof e.data.graphDefinitionHash === "string") return e.data.graphDefinitionHash;
  }
  return undefined;
}

export type EngagementCompare =
  | { comparable: true; recorded: string }
  | { comparable: false; reason: "mismatch"; recorded: string }
  | { comparable: false; reason: "unbound" };

// THE shared comparator (criterion: status and resume decide through one comparator). status reads
// .comparable; resume reads .comparable plus .reason/.recorded for its refusal message and the release.
export function engagementComparable(events: JournalEvent[], loadedHash: string): EngagementCompare {
  const recorded = recordedGraphDefinitionHash(events);
  if (recorded === undefined) return { comparable: false, reason: "unbound" };
  return recorded === loadedHash ? { comparable: true, recorded } : { comparable: false, reason: "mismatch", recorded };
}

const RUN_SEQUENCE_WIDTH = 16;

// The daemon mints before acquiring graph.lock, and each CLI invocation has fresh module state. Claim
// a repository-state ticket with mkdir's atomic EEXIST boundary instead: a losing process advances and
// retries, while the winning directory remains as the durable high-water evidence for later invocations.
function claimRunSequence(repoRoot = process.cwd()): string {
  const dir = join(tickmarkrDir(repoRoot), "run-id-sequence");
  mkdirSync(dir, { recursive: true });
  const allocated = readdirSync(dir).filter((name) => /^\d{16}$/.test(name));
  let candidate = allocated.reduce((max, name) => {
    const value = BigInt(name);
    return value > max ? value : max;
  }, 0n) + 1n;

  while (true) {
    const suffix = candidate.toString().padStart(RUN_SEQUENCE_WIDTH, "0");
    if (suffix.length > RUN_SEQUENCE_WIDTH) throw new Error("run id sequence exhausted");
    try {
      mkdirSync(join(dir, suffix));
      return suffix;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      candidate += 1n;
    }
  }
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const instant = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `run-${instant}-${claimRunSequence()}`;
}

// Sol #4: one strict parser for every journal open/create path — generated run-… ids plus test
// suffix chars only; forbid path separators, dot-segments, and empty ids.
export function parseRunId(runId: string): string {
  const id = runId.trim();
  if (!id) throw new Error("invalid run id: empty");
  if (id.includes("/") || id.includes("\\")) throw new Error(`invalid run id: ${runId}`);
  for (const seg of id.split(/[/\\]/)) {
    if (seg === "." || seg === "..") throw new Error(`invalid run id: ${runId}`);
  }
  if (!/^run-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`invalid run id: ${runId}`);
  return id;
}

const runsDir = (repoRoot: string) => join(repoRoot, stateDirName(repoRoot), "runs");

// One JSONL reader for every append-only log: skip blanks, drop any line that
// won't parse, keeping everything before it intact.
function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn trailing write after a crash — ignore; everything before it is intact
    }
  }
  return out;
}

// The tracked compatibility boundary additionally retains physical source identity. Keep it separate
// from readJsonl so the daemon's hot raw replay path pays no schema or wrapper-allocation cost.
function readJsonlSource(path: string): JournalSourceRow[] {
  if (!existsSync(path)) return [];
  const out: JournalSourceRow[] = [];
  for (const [sourceIndex, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      out.push({ sourceIndex, raw: JSON.parse(line) });
    } catch {
      // torn trailing write after a crash — ignore; everything before it is intact
    }
  }
  return out;
}

// Cross-run telemetry for Phase-12 profile derivation: the last K runs' rows, each
// tagged with its runId (runIds are zero-padded run-UTCYYYYMMDD-HHMMSS-sequence ⇒ plain .sort() is
// chronological, same as latestRunId). Rows are facts, not classifications — Phase 12
// owns the quality-denominator/reward policy. A safeParse failure drops that one row
// (same posture as a torn line); a garbage row must never crash profile derivation.
// Note: a per-task row attributes to the FINAL channel — a channel escalated away from
// mid-task contributes no row; accepted for v1.6.
export function readAllTelemetry(repoRoot: string, lastK: number, opts: { after?: string } = {}): (TelemetryRow & { runId: string })[] {
  const dir = runsDir(repoRoot);
  if (!existsSync(dir)) return [];
  let runIds = readdirSync(dir).filter((d) => d.startsWith("run-")).sort();
  // VIS-03 reset cursor: UTC clock fields and a fixed-width sequence make string > chronological
  if (opts.after) runIds = runIds.filter((id) => id > opts.after!);
  runIds = runIds.slice(-lastK);
  const out: (TelemetryRow & { runId: string })[] = [];
  for (const runId of runIds) {
    for (const raw of readJsonl(join(dir, runId, "telemetry.jsonl"))) {
      const r = TelemetryRowSchema.safeParse(raw);
      if (r.success && r.data.kind !== "judge") out.push({ ...r.data, runId });
    }
  }
  return out;
}

// ponytail: fixed 50-run window; promote to a routing.learned.* config knob only if operators need to tune it.
export const RUNS_WINDOW = 50;

// OBS-543/OBS-549 use the same documented recency budget the routing profile already trusts. There is
// one directory enumeration and one journal read per selected run; both compile history and fresh-run
// feedback consume this function's folded result, so neither grows an unbounded or second reader.
export const PRIOR_JOURNAL_RUN_WINDOW = RUNS_WINDOW;

export function readPriorRunEvidence(
  repoRoot: string,
  tasks: readonly Pick<Task, "id" | "goal" | "files" | "acceptance">[],
  opts: { suppressRunId?: string } = {},
): PriorRunEvidence {
  const dir = runsDir(repoRoot);
  if (!existsSync(dir)) return { findings: [], merges: [] };
  const runIds = readdirSync(dir)
    .filter((runId) => runId.startsWith("run-") && existsSync(join(dir, runId, "journal.jsonl")))
    .sort()
    .slice(-PRIOR_JOURNAL_RUN_WINDOW);
  const folded = foldPriorEvidence(runIds.map((runId) => ({
    runId,
    events: readJsonl(join(dir, runId, "journal.jsonl")) as JournalEvent[],
  })));
  const current = new Map(tasks.map((task) => [task.id, taskContentDigest(task)]));
  return {
    findings: folded.findings.filter((evidence) =>
      evidence.runId !== opts.suppressRunId
      && current.get(evidence.taskId) === evidence.taskContentDigest),
    merges: folded.merges.filter((evidence) =>
      evidence.runId !== opts.suppressRunId
      && current.get(evidence.taskId) === evidence.taskContentDigest),
  };
}

// VIS-03 reset cursor — one trimmed runId line at .tickmarkr/profile-since; absent/empty ⇒ undefined.
// Opaque: used ONLY in the runId > comparison above, never a shell or path join beyond .tickmarkr/.
export function readProfileCursor(repoRoot: string): string | undefined {
  const path = join(repoRoot, stateDirName(repoRoot), "profile-since");
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

// v1.46 T5 evidence hygiene state — one line per mark: `<runId> [<taskId>] <weight> # <reason>`.
// Follows the profile-since precedent: state file in .tickmarkr/, never config, never git.
const PROFILE_DISCOUNTS_RE =
  /^(run-[A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+(\S+))?\s+(0|0\.5)\s+#\s+(.+)$/;

export function profileDiscountsPath(repoRoot: string): string {
  return join(repoRoot, stateDirName(repoRoot), "profile-discounts");
}

export function readProfileDiscounts(repoRoot: string): ProfileDiscount[] {
  const path = profileDiscountsPath(repoRoot);
  if (!existsSync(path)) return [];
  const out: ProfileDiscount[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = PROFILE_DISCOUNTS_RE.exec(trimmed);
    if (!m) continue;
    out.push({
      runId: m[1],
      ...(m[2] ? { taskId: m[2] } : {}),
      weight: m[3] === "0" ? 0 : 0.5,
      reason: m[4].trim(),
    });
  }
  return out;
}

export function appendProfileDiscount(repoRoot: string, discount: ProfileDiscount): void {
  tickmarkrDir(repoRoot);
  const line = `${discount.runId}${discount.taskId ? ` ${discount.taskId}` : ""} ${discount.weight} # ${discount.reason}\n`;
  appendFileSync(profileDiscountsPath(repoRoot), line);
}

// The one shared profile builder (criterion 4: plan and daemon share ONE code path).
// preview:true bypasses the routing.learned:off short-circuit so `tickmarkr plan` can render the
// trust-ramp preview while the daemon (no preview) stays inert (VALIDATION 13-01-11).
export function loadRoutingProfile(repoRoot: string, cfg: TickmarkrConfig, opts: { preview?: boolean } = {}): RoutingProfile | undefined {
  if (cfg.routing.learned === "off" && !opts.preview) return undefined; // never built, never passed
  const rows = readAllTelemetry(repoRoot, RUNS_WINDOW, { after: readProfileCursor(repoRoot) });
  // ROUTE-15: halfLifeRuns threads from config as a pure param; undefined ⇒ module default (byte-identical).
  const discounts = readProfileDiscounts(repoRoot);
  return rows.length ? buildProfile(rows, { halfLifeRuns: cfg.routing.learnedTuning?.halfLifeRuns, discounts }) : undefined; // cold ⇒ undefined ⇒ v1.5 dead-code path
}

export class Journal {
  private constructor(
    public readonly dir: string,
    public readonly runId: string,
    private readonly narrate?: (event: JournalEvent) => void,
  ) {}

  static create(repoRoot: string, runId: string, narrate?: (event: JournalEvent) => void): Journal {
    const id = parseRunId(runId);
    const dir = join(runsDir(repoRoot), id);
    if (existsSync(join(dir, "journal.jsonl"))) throw new Error(`journal already exists for ${id}`);
    mkdirSync(dir, { recursive: true });
    return new Journal(dir, id, narrate);
  }

  static open(repoRoot: string, runId: string, narrate?: (event: JournalEvent) => void): Journal {
    const id = parseRunId(runId);
    const dir = join(runsDir(repoRoot), id);
    if (!existsSync(join(dir, "journal.jsonl"))) throw new Error(`no journal for ${id} at ${dir}`);
    return new Journal(dir, id, narrate);
  }

  // withJournal: journal.jsonl appears at first append, after Journal.create mkdirs — a caller that
  // will Journal.open the result (status, report) must fall back to the newest run that is actually
  // readable, not throw on the mkdir-to-first-append window. Raw default stays for telemetry-scoped
  // callers (profile cursor), where a journal-less run dir still counts.
  static latestRunId(repoRoot: string, opts: { withJournal?: boolean } = {}): string | null {
    if (!existsSync(runsDir(repoRoot))) return null;
    const ids = readdirSync(runsDir(repoRoot))
      .filter((d) => d.startsWith("run-") && (!opts.withJournal || existsSync(join(runsDir(repoRoot), d, "journal.jsonl"))))
      .sort();
    return ids.at(-1) ?? null;
  }

  private get journalPath() {
    return join(this.dir, "journal.jsonl");
  }

  // The object overload is the T32 write boundary: all new decision writes validate as one closed
  // union member before persistence. The tuple overload is retained solely for the current producer
  // corpus; T38/T40 own migrating those call sites, so this task neither dual-writes nor changes their
  // emitted bytes.
  append(decision: DecisionEventWrite): void;
  append(event: string, taskId?: string, data?: Record<string, unknown>): void;
  append(
    eventOrDecision: string | DecisionEventWrite,
    taskId?: string,
    data: Record<string, unknown> = {},
  ): void {
    const decisionRow: DecisionEvent | undefined = typeof eventOrDecision === "string"
      ? undefined
      : DecisionEventSchema.parse({ ...eventOrDecision, ts: new Date().toISOString() });
    const event = decisionRow?.event ?? eventOrDecision as string;
    const rowTaskId = decisionRow && "taskId" in decisionRow ? decisionRow.taskId : taskId;
    const inputData = decisionRow?.data ?? data;
    // OBS-738: terminal and resume records reduce the journal that precedes them. Neither re-derives
    // recovery facts from task-human prose: preserved refs come from preservedRefsByTask, and the
    // upheld brief comes from the established prompt/replay reducer.
    const priorEvents = event === "run-end" || event === "resume-restore" ? this.read() : [];
    const reducedData = event === "run-end"
      ? (() => {
          const preservedRefs = [...preservedRefsByTask(priorEvents)].flatMap(([preservedTaskId, refs]) =>
            refs.map(({ ref, diffCommand }) => ({ taskId: preservedTaskId, ref, diffCommand })));
          return preservedRefs.length > 0 ? { ...inputData, preservedRefs } : inputData;
        })()
      : event === "resume-restore" && rowTaskId && upheldFeedbackByTask(priorEvents).has(rowTaskId)
        ? {
            ...inputData,
            upheldFeedbackRestoredFor: rowTaskId,
            summary: `upheld feedback restored for ${rowTaskId}`,
          }
        : inputData;
    const evidence = judgePersistence.getStore();
    const failed = evidence?.invocations.filter((invocation) => invocation.transcript !== undefined) ?? [];
    const persistedData = event === "judge-retry" && failed.length > 0
      ? {
          ...reducedData,
          transcript: failed[0]!.transcript,
          ...(failed[1] ? { retryTranscript: failed[1].transcript } : {}),
        }
      : reducedData;
    const row: JournalEvent = decisionRow
      ? { ...decisionRow, data: persistedData }
      : { ts: new Date().toISOString(), event, ...(taskId ? { taskId } : {}), data: persistedData };
    // T3 secret redaction: only the persisted bytes are masked — the caller's data stays untouched in
    // memory. The narrator receives the persisted (masked) row so a pane sink never shows a credential.
    const line = redactSecrets(JSON.stringify(row));
    appendFileSync(this.journalPath, line + "\n");
    try {
      this.narrate?.(JSON.parse(line) as JournalEvent);
    } catch {
      // narration is observational; a broken sink must not affect the journal or run
    }
    if (evidence && !evidence.written && (event === "judge-retry" || event === "gate-result")) {
      evidence.written = true;
      for (const invocation of evidence.invocations) {
        const colon = invocation.channel.indexOf(":");
        const adapter = colon === -1 ? invocation.channel : invocation.channel.slice(0, colon);
        const model = colon === -1 ? "" : invocation.channel.slice(colon + 1);
        this.telemetry({
          kind: "judge",
          taskId: invocation.taskId,
          shape: "judge",
          adapter,
          model,
          channel: invocation.channel,
          attempts: 1,
          outcome: invocation.outcome,
          durationMs: invocation.durationMs,
          judgeOutcome: invocation.judgeOutcome,
        });
      }
    }
  }

  phaseStart(taskId: string, phase: TaskPhase, data: Record<string, unknown> = {}): void {
    this.append("phase-start", taskId, { ...data, phase });
  }

  read(): JournalEvent[] {
    return readJsonl(this.journalPath) as JournalEvent[];
  }

  readTracked(): TrackedJournalRow[] {
    return trackJournalRows(this.runId, readJsonlSource(this.journalPath));
  }

  replayStatuses(): Map<string, TaskStatus> {
    const s = new Map<string, TaskStatus>();
    for (const e of this.read()) {
      if (!e.taskId) continue;
      if (e.event === "task-dispatch") s.set(e.taskId, "running");
      else if (e.event === "task-done") s.set(e.taskId, "done");
      else if (e.event === "task-failed") s.set(e.taskId, "failed");
      else if (e.event === "task-human") s.set(e.taskId, "human");
      // GATE-08 (v1.12): approval is a journal EVENT, never a graph.json mutation (graph.json is compiled
      // output; recompile re-emits humanGate:true and would silently erase it — Phase 42 D-02). Events
      // replay in order, so task-human → task-approved lands on pending (last write wins). Additive-only:
      // 26 real journals with no such event replay byte-identically (D-04).
      else if (e.event === "task-approved") s.set(e.taskId, "pending");
    }
    for (const [id, st] of s) if (st === "running") s.set(id, "pending");
    return s;
  }

  // Phase 46 (RES-01/RES-02): companion replay — derives per-task resume state {attempts, tried,
  // lastAssignment} from EXISTING events only (task-dispatch + consult-verdict + optional v1.24
  // task-approved{release:attempt-cap}). Additive-only: no new required event, no schema change, the
  // status replay above is byte-untouched (corpus criterion 3 is git-diff-provable). Motivated by the
  // 2026-07-11 incident (run-20260711-185020, P43-03): `tickmarkr resume` re-dispatched at attempt 0 on
  // pi:zai/glm-5.2, the exact channel a frontier consult had just banned, because execTask's
  // attempt/tried/assignment state is loop-local and dies with the process while the journal held every fact needed.
  //
  // attempts is a COUNT of task-dispatch events, NEVER max(data.attempt)+1: existing journals'
  // post-resume dispatches restart at 0 (the bug corrupted its own evidence — incident journal L58
  // logged attempt 0 two ms after run-resume). Count === max+1 on clean journals and is truthful on
  // corrupted ones. tried is the ordered dedup of channelKey(assignment) across dispatches (≡ the
  // pre-kill tried list). lastAssignment is the last well-formed dispatched assignment.
  /**
   * OBS-547: the task's latest dispatch IFF a `scope-authoring` event already closed it — the state a
   * crash between that classification and the park that follows it leaves behind. replayResumeState()
   * has already rewound that dispatch, so a resumed gate replay must neither take it back a second time
   * (which erases an EARLIER chargeable attempt) nor attribute the park to the assignment the rewind
   * restored. null ⇒ the latest dispatch is unclassified: today's accounting, unchanged.
   */
  classifiedDispatch(taskId: string): { assignment?: Assignment } | null {
    let outstanding: { assignment?: Assignment } | null = null;
    let classified: { assignment?: Assignment } | null = null;
    for (const e of this.read()) {
      if (e.taskId !== taskId) continue;
      if (e.event === "task-dispatch") {
        const parsed = DispatchAssignmentSchema.safeParse(e.data.assignment);
        outstanding = parsed.success ? { assignment: parsed.data } : {}; // malformed: closable, unattributable
        classified = null;
      } else if (e.event === "scope-authoring" && outstanding) {
        classified = outstanding; // a duplicate classification closes nothing more (same rule as the replay)
        outstanding = null;
      }
    }
    return classified;
  }

  replayResumeState(): Map<string, ResumeState> {
    const m = new Map<string, ResumeState>();
    const events = this.read();
    // Keep the legacy resume-state field aligned with the journal-authoritative prompt-time fold.
    // In particular, a review pass after an uphold must erase the fallback daemon.ts may consult.
    const activeUpheldFeedback = upheldFeedbackByTask(events);
    const pendingReroute = new Set<string>(); // reroute verdicts not yet cleared by a later dispatch
    // OBS-547: what the last dispatch ADDED, so a scope-authoring event can take it back. An
    // unchargeable dispatch must replay as if it never happened — no attempt counted, no channel burned.
    const lastDispatch = new Map<string, {
      addedKey?: string;
      prevAssignment?: Assignment;
      consumedReroute: boolean;
    }>();
    const lastReviewFail = new Map<string, string>(); // OBS-189: newest failed review details per task
    for (const e of events) {
      if (!e.taskId) continue;
      if (e.event === "gate-result" && e.data.gate === "review" && e.data.pass === false
          && typeof e.data.details === "string") {
        lastReviewFail.set(e.taskId, e.data.details);
      }
      if (e.event === "task-dispatch") {
        // A subsequent dispatch clears the pending reroute — the reroute was acted on pre-kill.
        const consumedReroute = pendingReroute.delete(e.taskId);
        let st = m.get(e.taskId);
        if (!st) { st = { attempts: 0, tried: [] }; m.set(e.taskId, st); }
        st.attempts++; // COUNT, never max(data.attempt)+1 — see rationale above
        const parsed = DispatchAssignmentSchema.safeParse(e.data.assignment);
        if (parsed.success) {
          const key = channelKey(parsed.data);
          const added = !st.tried.includes(key);
          if (added) st.tried.push(key);
          lastDispatch.set(e.taskId, {
            ...(added ? { addedKey: key } : {}),
            prevAssignment: st.lastAssignment,
            consumedReroute,
          });
          st.lastAssignment = parsed.data;
        } else {
          lastDispatch.set(e.taskId, { prevAssignment: st.lastAssignment, consumedReroute });
          // fail closed: malformed assignment still COUNTS (above) but adds nothing to tried and
          // poisons only lastAssignment (a malformed LAST dispatch must not be restored).
          st.lastAssignment = undefined;
        }
      } else if (e.event === "scope-authoring") {
        // OBS-547: the dispatch this event closes was an authoring defect — the spec is missing a
        // files[] line and the worker was never at fault. Rewind its accounting so a resume neither
        // charges the attempt nor treats its channel as burned.
        // Idempotent: undo the OUTSTANDING dispatch or nothing. A crash between this append and the
        // park that follows it makes a resume classify again and append a duplicate — the duplicate has
        // no dispatch left to take back, and an unconditional decrement would erase an EARLIER
        // chargeable attempt instead (the clamp at zero only hides that when there is no earlier one).
        const st = m.get(e.taskId);
        const undo = lastDispatch.get(e.taskId);
        if (st && undo) {
          st.attempts = Math.max(0, st.attempts - 1);
          if (undo.addedKey) st.tried = st.tried.filter((k) => k !== undo.addedKey);
          st.lastAssignment = undo.prevAssignment;
          if (undo.consumedReroute) pendingReroute.add(e.taskId);
          lastDispatch.delete(e.taskId);
        }
      } else if (e.event === "consult-verdict" && e.data.action === "reroute") {
        // A reroute bans the in-force channel; retry/decompose/human verdicts ban nothing (D-03).
        pendingReroute.add(e.taskId);
      } else if (e.event === "task-approved"
                 && (e.data.release === ATTEMPT_CAP_RELEASE || e.data.release === RECHECK_RELEASE)) {
        // v1.24 OBS-18: operator released an attempt-cap park. Pre-v1.24 task-approved events have no
        // `release` key ⇒ this branch never fires (corpus criterion: identical statuses + resume state).
        // attempts reset to 0 so the daemon's attempt-cap check does not re-park in the same tick;
        // tried survives (consult bans and burned channels are not forgotten); lastAssignment is
        // cleared so the daemon's nextChannel-over-tried path skips burned channels on first dispatch
        // (restoring the last burned assignment would re-try it first — the failure the tried-list exists to prevent).
        const st = m.get(e.taskId);
        if (st) {
          st.attempts = 0;
          st.lastAssignment = undefined;
        }
      } else if (e.event === "task-approved" && e.data.release === REVIEW_UPHELD_RELEASE) {
        // OBS-189: the operator upheld the reviewer. Same budget semantics as the attempt-cap release
        // (fresh attempts, tried survives, no burned-channel restore) PLUS the findings carry: the
        // newest failed review's details ride into the funded attempt as its retry brief.
        const st = m.get(e.taskId);
        if (st) {
          st.attempts = 0;
          st.lastAssignment = undefined;
          const details = lastReviewFail.get(e.taskId);
          if (details) st.upheldFeedback = details;
        }
      }
    }
    // Trailing-reroute edge (D-01 kill between verdict and dispatch): a reroute verdict with NO
    // subsequent dispatch means the last-dispatched channel is itself banned — add it to tried (if
    // absent) and clear lastAssignment so the daemon falls back to nextChannel over the exclusions.
    for (const taskId of pendingReroute) {
      const st = m.get(taskId);
      if (st?.lastAssignment) {
        const key = channelKey(st.lastAssignment);
        if (!st.tried.includes(key)) st.tried.push(key);
        st.lastAssignment = undefined;
      }
    }
    for (const [taskId, st] of m) {
      const feedback = activeUpheldFeedback.get(taskId);
      if (feedback) st.upheldFeedback = feedback;
      else delete st.upheldFeedback;
    }
    return m;
  }

  // OBS-130: gate satisfaction is authority, not an inferred daemon state. Only an explicit
  // task-approved event with the typed release marker and a known gate enters this fold. A daemon-made
  // gate-satisfied event, a prior pass/fail result, malformed data, or another task's approval is inert.
  replaySatisfiedGates(): Map<string, GateName> {
    const satisfied = new Map<string, GateName>();
    for (const e of this.read()) {
      if (e.event !== "task-approved" || !e.taskId || e.data.release !== GATE_SATISFIED_RELEASE) continue;
      if (typeof e.data.gate === "string" && (GATE_NAMES as readonly string[]).includes(e.data.gate)) {
        satisfied.set(e.taskId, e.data.gate as GateName);
      }
    }
    return satisfied;
  }

  // T15: replay completed measurements from the CURRENT worker attempt. A later task-dispatch starts
  // a new attempt and erases every older result; a result naming a different commit starts a new
  // commit-scoped set. Last result per gate wins, so a later failure retracts a pass and a later pass
  // can replace a failure. Missing/malformed commit or gate data is inert and therefore never skipped.
  // This fold never derives satisfaction from task-approved: failed-gate authority belongs
  // exclusively to replaySatisfiedGates(), whose typed release-marker contract above is unchanged.
  replayCurrentAttemptGateResults(): Map<string, CurrentAttemptGateReplay> {
    const replay = new Map<string, CurrentAttemptGateReplay>();
    for (const e of this.read()) {
      if (!e.taskId) continue;
      if (e.event === "task-dispatch") {
        replay.delete(e.taskId);
        continue;
      }
      // Releases that buy another worker deliberately end the attempt whose measurements preceded
      // them. An untyped approval and gate-satisfied stay in their own authority semantics: neither
      // can turn a failure into observed green here.
      if (e.event === "task-approved"
          && (e.data.release === ATTEMPT_CAP_RELEASE || e.data.release === RECHECK_RELEASE
            || e.data.release === REVIEW_UPHELD_RELEASE)) {
        replay.delete(e.taskId);
        continue;
      }
      if (e.event !== "gate-result") continue;
      if (typeof e.data.commit !== "string" || typeof e.data.gate !== "string"
          || !(GATE_NAMES as readonly string[]).includes(e.data.gate)) {
        replay.delete(e.taskId); // a newer unattributable verdict invalidates the older candidate
        continue;
      }
      let state = replay.get(e.taskId);
      if (!state || state.commit !== e.data.commit) {
        state = { commit: e.data.commit, results: new Map() };
        replay.set(e.taskId, state);
      }
      // A selected-test green is explicitly a screen, never the merge verdict. Only its later
      // fullSuite replacement may survive a restart as a satisfied test gate.
      const incompleteTest = e.data.gate === "test" && Array.isArray(e.data.selectedTests)
        && e.data.fullSuite !== true;
      const satisfied = !incompleteTest
        && (e.data.pass === true || e.data.skipped === true) && e.data.infra !== true;
      state.results.set(e.data.gate as GateName, satisfied);
    }
    return replay;
  }

  // v1.71 OBS-119: run-wide exclusion fold — same replay discipline as replayResumeState().
  // channel-exclusion is the typed event; dead-channel-failover.from is the pre-v1.71 compat seam.
  replayExcludedChannels(): Set<string> {
    const excluded = new Set<string>();
    for (const e of this.read()) {
      if (e.event === "channel-exclusion" && typeof e.data.channel === "string") {
        excluded.add(e.data.channel);
      } else if (e.event === "dead-channel-failover" && typeof e.data.from === "string") {
        excluded.add(e.data.from);
      }
    }
    return excluded;
  }

  telemetry(row: TelemetryRow): void {
    // T3 secret redaction: same persistence seam as append — credential-free rows are byte-identical.
    appendFileSync(join(this.dir, "telemetry.jsonl"), redactSecrets(JSON.stringify(row)) + "\n");
  }

  // Per-run task rows stay byte-compatible for legacy readers (report and task-level test helpers).
  // Judge rows share telemetry.jsonl but have a dedicated reader so their earlier gate-time ordering
  // cannot make a find(taskId) caller mistake invocation evidence for the later terminal task row.
  readTelemetry(): TelemetryRow[] {
    return readJsonl(join(this.dir, "telemetry.jsonl"))
      .filter((row) => !(row && typeof row === "object" && "kind" in row && row.kind === "judge")) as TelemetryRow[];
  }

  readJudgeTelemetry(): TelemetryRow[] {
    return readJsonl(join(this.dir, "telemetry.jsonl"))
      .filter((row) => row && typeof row === "object" && "kind" in row && row.kind === "judge") as TelemetryRow[];
  }
}
