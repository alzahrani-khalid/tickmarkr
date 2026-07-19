// group: role-tab consolidation (VIS-04) — same-group slots share one ref-counted tab (herdr only)
export interface Slot { id: string; name: string; cwd: string; tabId?: string; group?: string }
export type NotifyTier = "routine" | "attention";
export interface NotifyOpts { tier?: NotifyTier; sound?: "none" | "done" | "request" }
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
// right now. In-workspace: the existing desired-set/spareLiveLlm sweep (OBS-17 T2). Out-of-workspace:
// an owned pane from a DIFFERENT run is a misplaced leftover (bug, foreign actor, pre-VIS-10 relic)
// and closes regardless of `desired`; an owned pane from THIS run elsewhere is left alone — a live
// run can legitimately hold panes across workspaces, so only run age marks a misplaced pane garbage.
// Watch panes are operator-owned after run end and are reclaimed by the next run; foreign names
// (parseOwnedName fails) are never candidates, in any workspace.
export function panesToClose(
  agents: FleetAgent[],
  desired: Set<string>,
  ws: string,
  runId: string,
  opts?: { spareLiveLlm?: boolean },
): { paneId: string; tabId?: string }[] {
  const out: { paneId: string; tabId?: string }[] = [];
  for (const a of agents) {
    if (typeof a.name !== "string" || typeof a.paneId !== "string") continue;
    const owned = parseOwnedName(a.name);
    if (!owned || owned.role === "watch") continue;
    if (a.workspaceId === ws) {
      if (desired.has(a.name)) continue;
      if (opts?.spareLiveLlm && owned.runId === runId && (owned.role === "judge" || owned.role === "review" || owned.role === "consult")) continue;
    } else if (owned.runId === runId) {
      continue; // this run's own pane in another workspace — never touched
    }
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
  notify(msg: string, opts?: NotifyOpts): Promise<void>;
  close(slot: Slot): Promise<void>;
  worktree(repo: string, branch: string, baseRef: string): Promise<string>;
  // T6 narrator: one live status surface per run (herdr only). Opens a rightward split beside the
  // invoking daemon pane, runs the given command, and returns the slot for run-end close. Omitted on
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
  reconcile?: (desired: Set<string>, runId: string, opts?: { spareLiveLlm?: boolean }) => Promise<void>;
}
