import type { JournalEvent } from "../run/journal.js";
// group: role-tab consolidation (VIS-04) — same-group slots share one ref-counted tab (herdr only)
export interface Slot { id: string; name: string; cwd: string; tabId?: string; group?: string }
export type NotifyTier = "routine" | "attention" | "decision";
export interface NotifyOpts { tier?: NotifyTier; sound?: "none" | "done" | "request" }

export type DecisionEventType =
  | "phase-change"
  | "gate-verdict"
  | "escalation"
  | "human-decision-required"
  | "run-end";

// Stable transport shape for `status --watch --events`. Every field is projected from one journal
// row plus its line number; the watch owns no cursor outside its process and persists nothing.
export interface DecisionEvent {
  version: 1;
  sequence: number;
  type: DecisionEventType;
  tier: "routine" | "decision";
  ts: string;
  runId: string;
  taskId?: string;
  evidence: string;
  phase?: string;
  gate?: string;
  verdict?: "passed" | "failed" | "skipped" | "unknown";
  step?: string;
  attempt?: number;
  kind?: string;
  reason?: string;
  approvalCommand?: string;
  summary?: Record<string, unknown>;
}

export type DecisionWebhookPost = (url: string, event: DecisionEvent) => void | Promise<unknown>;
// group → shared ref-counted stage tab (workers); label → dedicated role tab (SUP-01). herdr-only visuals.
// owned → explicit ownership-contract identity (T1). When omitted, the driver derives one from `name`
// via canonicalizeLegacyName so every pane it actually creates still gets a contract-compliant name —
// T2 threads `owned` through daemon/gates/consult call sites directly and retires the legacy parsing.
export interface SlotOpts { group?: string; label?: string; owned?: OwnedName }

// ---- Ownership contract (T1: OBS-17 pane-hygiene) --------------------------------------------
// Every pane/tab tickmarkr creates is identified by exactly one parseable token:
//   tickmarkr:<role>:<taskId>:<attempt>:<runId>
// role ∈ OWNED_ROLES; attempt is a non-negative integer; taskId/runId never contain ":" (task and
// run ids are alphanumeric/dash by construction elsewhere). formatOwnedName/parseOwnedName round-trip
// exactly. parseOwnedName (or isForeignName) is the ONLY way reconcile.ts may decide a live pane name
// is tickmarkr-owned — anything that doesn't parse is foreign and is never a candidate for closing.
export const OWNED_ROLES = ["worker", "judge", "review", "consult", "watch", "other"] as const;
export type OwnedRole = (typeof OWNED_ROLES)[number];
export interface OwnedName { role: OwnedRole; taskId: string; attempt: number; runId: string }

const OWNED_PREFIX = "tickmarkr";
const OWNED_RE = new RegExp(`^${OWNED_PREFIX}:(${OWNED_ROLES.join("|")}):([^:]+):(\\d+):([^:]+)$`);

export function formatOwnedName(o: OwnedName): string {
  return `${OWNED_PREFIX}:${o.role}:${o.taskId}:${o.attempt}:${o.runId}`;
}

export function parseOwnedName(name: string): OwnedName | null {
  const m = OWNED_RE.exec(name);
  if (!m) return null;
  return { role: m[1] as OwnedRole, taskId: m[2], attempt: Number(m[3]), runId: m[4] };
}

export function isForeignName(name: string): boolean {
  return parseOwnedName(name) === null;
}

// v1.22b T1: a live fleet snapshot row — driver-agnostic (herdr's "agent list" shape today, but
// nothing here depends on that CLI's field names).
export interface FleetAgent { name?: string; paneId?: string; tabId?: string; workspaceId?: string }

// v1.22b T1: workspace-aware fold over a fleet snapshot — decides which owned task panes are garbage
// right now: the desired-set/spareLiveLlm sweep (OBS-17 T2), scoped to THIS RUN'S OWN panes (by runId,
// OBS-772) in THIS RUN'S OWN WORKSPACE (OBS-769). Both conditions, and neither alone is the rule.
// Watch panes are operator-owned after run end and are reclaimed by the next run; foreign names
// (parseOwnedName fails) are never candidates.
//
// OBS-769 — WHY THE SWEEP STOPS AT THE WORKSPACE BOUNDARY. It used to close an owned pane carrying
// any OTHER runId in any other workspace, unconditionally, as a "misplaced leftover". Two tickmarkr
// runs in two repositories are lawful (the lock forbids two runs in ONE repository, not on one
// machine) and herdr gives each its own workspace — so that branch made every pair of concurrent
// runs kill each other's LIVE workers. Measured 2026-08-28: the run in w0 closed run ...2958's
// panes at 23:42:40.351/.392, and 53s later ...2958's own task-human sweep closed w0's live codex
// worker at 23:43:34.096. ...2958 ended 0/8. The death detector cannot see it: closing the pane
// makes paneAbsent, processTree, confirmedProcessTree and worktreeDelta true by ONE cause, and a
// closed pane can never accrue the CPU that the `cpu-accruing` hold reads.
// The comment this replaces claimed "only run age marks a misplaced pane garbage" — there was no age
// check in the code, and age is the wrong predicate anyway: w0's run STARTED EARLIER than ...2958,
// so an age rule would have licensed exactly the kill that landed. Run age says nothing about
// liveness, and a sweeping daemon cannot read another repository's run state. The workspace is the
// only ownership boundary available without cross-repo I/O, so it is the one enforced.
// Cost, named: an orphan pane from a dead run stranded in a workspace no later run opens is now left
// for the operator. That is cosmetic (`reconcile` is cosmetic by contract — "visibility is never a
// gate"), and a cosmetic cleanup must never be able to kill a live worker.
// OBS-772 — WHY THE runId LINE EXISTS, AND WHY THE WORKSPACE LINE ALONE WAS NOT THE FIX. The first
// repair was workspace-scoped only, and its own comment dismissed the residue — "two runs sharing one
// workspace would still sweep each other" — as unreachable, on the reasoning that one workspace per run
// is herdr's placement. That reasoned from ONE driver to the whole product. OrcaDriver has no workspace
// dimension at all: orca.ts passes a single ORCA_SPACE as the workspaceId for EVERY checkout and as
// `ws`, so `workspaceId !== ws` is never true there and every foreign pane fell straight through. Orca
// users had zero protection while the defect read as fixed. The runId line is the real rule and it is
// driver-agnostic: reconcile exists to clean up THIS RUN's panes, and a leftover from a dead run is
// exactly what cannot be told from a live run's pane without liveness data this process does not have.
// Both lines are kept — the workspace line preserves the pre-existing sparing of this run's own panes
// in another workspace, which the runId line alone would not.
// ⚠ WHAT THE runId LINE COST BEFORE OBS-777 — SUSPENDED, NOT NARROWED, and the price was larger than
// it read. Sparing every other runId suspended OBS-17's FOUNDING use case: "a killed daemon can't
// close its slots". This sweep was built to reclaim exactly those orphans, but could not reclaim ANY
// previous run's panes. Three separate pins asserted the old behaviour (reconcile.test.ts,
// orca-placement.test.ts,
// reconcile-live.test.ts); all three were changed deliberately, and the third is why this paragraph
// exists rather than a shorter one — two flipped pins is a trade, three is a pattern.
// OBS-777 RESTORES that reclamation: the CALLER passes `opts.endedRunIds`, a Set the daemon computes
// ONCE at run start from this repository's own `run-end` journals and dead lock holders. This fold
// stays pure — it gains one optional field, not a repo root — a foreign repository's runId is never
// resolvable and so stays spared by construction, and no driver learns about workspaces.
// ponytail: two conditions, no geometry reasoning, nothing driver-specific. `reconcile` is cosmetic by
// contract, and a cosmetic cleanup must never be able to kill a live worker — which is why the
// ended-run authority is the only safe way to restore the sweep without reviving the cross-run kill.
export interface PanesToCloseOpts {
  spareLiveLlm?: boolean;
  endedRunIds?: Set<string>;
  liveSeats?: Set<string>;
}

export function panesToClose(
  agents: FleetAgent[],
  desired: Set<string>,
  ws: string,
  runId: string,
  opts?: PanesToCloseOpts,
): { paneId: string; tabId?: string }[] {
  const out: { paneId: string; tabId?: string }[] = [];
  for (const a of agents) {
    if (typeof a.name !== "string" || typeof a.paneId !== "string") continue;
    const owned = parseOwnedName(a.name);
    if (!owned || owned.role === "watch") continue;
    if (opts?.liveSeats?.has(a.name)) continue;
    if (owned.runId !== runId && !opts?.endedRunIds?.has(owned.runId)) continue;
    if (a.workspaceId !== ws) continue; // OBS-769: another workspace is another run's business
    if (desired.has(a.name)) continue;
    if (opts?.spareLiveLlm && owned.runId === runId && (owned.role === "judge" || owned.role === "review" || owned.role === "consult")) continue;
    out.push({ paneId: a.paneId, tabId: a.tabId });
  }
  return out;
}

// Legacy raw name shapes daemon.ts/gates/llm.ts/consult.ts/herdr.ts's narrator() build today (daemon.ts
// and gates/llm.ts are out of this task's file scope): "<taskId>-worker-<adapter>-a<attempt>-<runTag>"
// (daemon.ts), "<role> · <taskId>[-r1]" (gates/llm.ts gatePaneName, also covers consult.ts), and
// "narrator-watch-<pid>" (herdr.ts). This is the ONE place that knows their shapes — used by
// HerdrDriver's internal bookkeeping (renameGroupTab/glyphFor) and by reconcile.ts to recognize what
// a live pane's REAL name decodes to, without requiring a call-site migration yet. Callers that
// already have the structured fields should pass `owned` directly instead (T2 retires this parsing).
// runId is supplied by the caller's own run context, not read out of the string — none of today's
// legacy shapes lexically carry it except the worker shape's runTag.
const WORKER_RE = /^(.+)-worker-.+-a(\d+)-(.+)$/;
const GATE_ROLE_RE = /^(judge|review|consult) · (.+)$/;
const NARRATOR_RE = /^narrator-watch-\d+$/;

export function canonicalizeLegacyName(name: string, runId: string): OwnedName {
  const already = parseOwnedName(name);
  if (already) return already;
  const w = WORKER_RE.exec(name);
  if (w) return { role: "worker", taskId: w[1], attempt: Number(w[2]), runId: `run-${w[3]}` };
  const g = GATE_ROLE_RE.exec(name);
  if (g) {
    const retry = g[2].endsWith("-r1");
    return { role: g[1] as OwnedRole, taskId: retry ? g[2].slice(0, -3) : g[2], attempt: retry ? 1 : 0, runId };
  }
  if (NARRATOR_RE.test(name)) return { role: "watch", taskId: "run", attempt: 0, runId };
  return { role: "other", taskId: name, attempt: 0, runId };
}

export interface ExecutorDriver {
  id: string;
  // v1.2: can this driver host a live TUI the operator can watch and answer? (herdr yes, subprocess no)
  interactive: boolean;
  slot(cwd: string, name: string, opts?: SlotOpts): Promise<Slot>;
  run(slot: Slot, cmd: string): Promise<void>;
  waitOutput(slot: Slot, pattern: string, timeoutMs: number, opts?: { regex?: boolean }): Promise<boolean>;
  waitAgentStatus(slot: Slot, status: string, timeoutMs: number): Promise<boolean>;
  // live agent status of the slot's pane ("blocked" pages the operator); "unknown" when undetectable
  status(slot: Slot): Promise<string>;
  read(slot: Slot, lines: number): Promise<string>;
  // v1.22 T5 / OBS-19: send a raw keystroke into the pane's foreground TUI (e.g. Enter to accept
  // cursor's "Workspace Trust Required"). Optional — subprocess has no TUI dialogs; herdr implements
  // via `pane send-keys`. The daemon auto-answers a fingerprint-matched trust dialog once per slot
  // only when this is present; any other blocked dialog still pages the operator.
  sendKey?(slot: Slot, key: string): Promise<void>;
  // OBS-201: one latched liveness nudge into a live worker TUI — the daemon's ACTIVE response to an
  // idle pane holding no trailer (the passive stall window burned 289 min in one day). Optional —
  // subprocess workers are headless and cannot be nudged; herdr routes it through the SAME
  // verified-delivery pincer as dispatch (OBS-85 readiness/read-back, OBS-140 verified submit) at
  // the PINNED delivered pane, never a fresh label resolution. Returns delivered-or-not; a false
  // or a throw are the same to the caller (journal + fall back to the window). Best-effort by
  // contract: a nudge must never fail a run.
  nudge?(slot: Slot, message: string): Promise<boolean>;
  notify(msg: string, opts?: NotifyOpts): Promise<void>;
  close(slot: Slot): Promise<void>;
  // v1.99 T2: bind this driver's OWN journal writes to the live narration sink. A driver journals
  // events the daemon never sees — `dispatch-retry` is written by the driver from inside a recovery,
  // through a Journal it opens itself — so without this binding those events reach the file and the
  // pipe but never the operator's rail. The command that owns the run (run.ts / resume.ts) calls it
  // with the same sink it hands the daemon. Optional — subprocess journals nothing of its own.
  narrateWith?(narrate: (event: JournalEvent) => void): void;
  worktree(repo: string, branch: string, baseRef: string): Promise<string>;
  // T6 narrator: one live status surface per run (herdr only). Splits the invoking daemon pane down
  // and swaps the new pane ABOVE it — the board is full width with the narration rail beneath it, at
  // every terminal width — runs the given command, and returns the slot for run-end close. Omitted on
  // subprocess (no panes) — the daemon's optional-chain call is a no-op there. Cosmetic-only by
  // contract: the daemon swallows any failure so a dead/failed watch pane never affects the run.
  // T2: runId names the pane canonically (tickmarkr:watch:run:0:<runId>) so reconcile can own or reuse it.
  narrator?: (cwd: string, command: string, runId?: string) => Promise<Slot>;
  // OBS-17 T2: sweep tickmarkr-owned panes down to `desired` (the reconcile.ts journal fold) — close
  // owned-but-undesired panes and any tab a close emptied, including leftovers from OLDER runs of
  // the same repo. Ownership is decided ONLY by parseOwnedName; foreign names and operator tabs are
  // never candidates. spareLiveLlm: mid-run sweeps spare same-run judge/review/consult panes, whose
  // lifecycle events lag the journal (a live consult has no journal row until its verdict lands).
  // Cosmetic by contract: implementations swallow every failure and never throw. Omitted on
  // subprocess (no panes) — the daemon's optional-chain call is a no-op there.
  reconcile?: (desired: Set<string>, runId: string, opts?: PanesToCloseOpts) => Promise<void>;
}
