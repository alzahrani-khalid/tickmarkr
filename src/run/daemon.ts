import { randomBytes } from "node:crypto";
import { shq } from "../adapters/types.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { trailerPattern, writePrompt } from "../adapters/prompt.js";
import { allAdapters, discoverChannels, getAdapter, probeAll, readDoctor } from "../adapters/registry.js";
import { type Assignment, addUsage, channelKey, matchesTrustDialog, QUOTA_RE, type TokenUsage, type WorkerAdapter } from "../adapters/types.js";
import { bannerShell, paneDispatchCommand } from "../brand.js";
import {
  globalConfigDir, loadConfigWithMode, readOverlayFile, repoOverlayPath,
  type ModeResolution, type RoutingMode, type TickmarkrConfig,
} from "../config/config.js";
import { herdrSealShellPrefix, SubprocessDriver } from "../drivers/subprocess.js";
import { formatOwnedName, type ExecutorDriver, type Slot } from "../drivers/types.js";
import { type Baseline, captureBaseline, detectGateCommands } from "../gates/baseline.js";
import { runGates, type GateEvent } from "../gates/run-gates.js";
import type { GateResult } from "../gates/types.js";
import { addEvidence, attributeBlocked, blockedTasks, getTask, graphDefinitionHash, loadGraph, pendingTasks, readyTasks, saveGraph, setStatus } from "../graph/graph.js";
import type { Task } from "../graph/schema.js";
import { augmentRetryBrief, consult, renderRetryGuidance, type ConsultVerdict } from "./consult.js";
import { cleanupRunWorktrees, gitHead, linkNodeModules, sh, shGit, WORKTREE_LAYOUT_CONTRACT, worktreePath } from "./git.js";
import { classifyWorkerResultCause, engagementComparable, Journal, loadRoutingProfile, newRunId, type JournalEvent, type ParkKind, type ResumeState, type RetryMode } from "./journal.js";
import { acquireRunLock, releaseRunLock } from "./lock.js";
import { ensureIntegration, integrationBranch, integrationHead, mergeTask, verifyIntegrationTip } from "./merge.js";
import { nextChannel, route } from "../route/router.js";
import { desiredPanes } from "./reconcile.js";
import { normalizeStallSnapshot } from "./stall.js";

export interface RunOptions {
  runId?: string;
  resume?: boolean;
  // v1.53 T5: prior run this run supersedes. Validated before any state for the new run exists;
  // the prior journal gains ONE appended `superseded` event (append-only, never rewritten).
  supersedes?: string;
  // T3 (Sol #2 / Fable F2): operator's audited release of the engagement-identity guard so the
  // sanctioned stop-amend-resume workflow keeps working — the daemon refuses a mismatched/unbound
  // journal unless this is set, then journals a graph-rehash event naming both hashes.
  graphChanged?: boolean;
  concurrency?: number;
  driver?: ExecutorDriver;
  adapters?: WorkerAdapter[];
  globalDir?: string;
  // v1.51 T2: run-flag routing mode (--mode / the --quality alias) — the strongest mode source.
  mode?: RoutingMode;
  narrate?: (event: JournalEvent) => void;
  // v1.54 T2: test seam — replaces process.exit in the termination reaper (the vitest process must
  // survive a synthetic signal). Production omits it and the reaper exits the process.
  exit?: (code: number) => void;
}

// v1.51 T2: mode sources — run flag > spec front-matter > repo config > global config > default.
export type ModeSource = "run flag" | "spec" | "repo config" | "global config" | "default";

const MODE_RANK: Record<RoutingMode, number> = { "staff-led": 0, "risk-based": 1, "partner-led": 2 };

export interface ResolvedRunMode {
  cfg: TickmarkrConfig;
  /** effective mode + per-floor provenance + standing lints, from the ONE preset compiler in config.ts */
  mode: ModeResolution;
  source: ModeSource;
  /** set when the run flag picked a mode below the spec-declared mode (loud warn; --route-strict refuses) */
  conflict?: string;
}

// An override (flag/spec) re-resolves through loadConfigWithMode itself, via a synthesized repo overlay
// carrying routing.mode — floors, explore, lints, and provenance all come from config.ts's preset
// compiler, never duplicated mode math here (the quality-silently-loses defense holds by construction).
function withOverlayMode(repoRoot: string, mode: RoutingMode, globalDir?: string): { cfg: TickmarkrConfig; mode: ModeResolution } {
  const overlay = readOverlayFile(repoOverlayPath(repoRoot));
  const tmp = mkdtempSync(join(tmpdir(), "tickmarkr-mode-"));
  try {
    mkdirSync(join(tmp, ".tickmarkr"), { recursive: true });
    writeFileSync(
      join(tmp, ".tickmarkr", "config.yaml"),
      stringify({ ...overlay, routing: { ...(overlay.routing as Record<string, unknown> | undefined), mode } }),
    );
    return loadConfigWithMode(tmp, { globalDir });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function resolveRunMode(
  repoRoot: string,
  opts: { flag?: RoutingMode; spec?: RoutingMode; globalDir?: string } = {},
): ResolvedRunMode {
  const overlayMode = (path: string): unknown =>
    (readOverlayFile(path) as { routing?: { mode?: unknown } }).routing?.mode;
  const source: ModeSource = opts.flag !== undefined ? "run flag"
    : opts.spec !== undefined ? "spec"
    : overlayMode(repoOverlayPath(repoRoot)) !== undefined ? "repo config"
    : overlayMode(join(opts.globalDir ?? globalConfigDir(), "config.yaml")) !== undefined ? "global config"
    : "default";
  const override = opts.flag ?? opts.spec;
  const base = loadConfigWithMode(repoRoot, { globalDir: opts.globalDir });
  const resolved = override === undefined || override === base.mode.mode
    ? base
    : withOverlayMode(repoRoot, override, opts.globalDir);
  const conflict = opts.flag !== undefined && opts.spec !== undefined && MODE_RANK[opts.flag] < MODE_RANK[opts.spec]
    ? `mode conflict: run flag ${opts.flag} selects a mode below the spec-declared ${opts.spec} — the run flag wins this run`
    : undefined;
  return { cfg: resolved.cfg, mode: resolved.mode, source, ...(conflict ? { conflict } : {}) };
}

export interface RunSummary {
  runId: string;
  branch: string;
  done: string[];
  failed: string[];
  human: string[];
  pending: string[];
  blocked: string[];
  tipVerify?: "passed" | "failed";
  lastMergedTask?: string;
}

// VIS-01: one formatter, four readers (run-end journal event, run/resume CLI, run-end notify).
// Parity by construction — every caller renders the same complete bucket line.
export function formatSummary(s: RunSummary): string {
  const tip = s.tipVerify === "failed"
    ? `\ntip verify: FAILED${s.lastMergedTask ? ` (last merged: ${s.lastMergedTask})` : ""}`
    : s.tipVerify === "passed" ? "\ntip verify: passed" : "";
  return `done: ${s.done.length}, failed: ${s.failed.length}, human: ${s.human.length}, blocked: ${s.blocked.length}, pending: ${s.pending.length}\nintegration branch: ${s.branch}${tip}`;
}

const MAX_ATTEMPTS = 10; // ponytail: hard cap so a pathological ladder can never loop forever
const BLOCKED_POLL_MS = 30_000; // between trailer-wait slices, check whether the pane is blocked on a prompt
const PROVIDER_DEATH_REQUEUE_CAP = 2; // v1.46 T1: requeue same assignment twice, then fall through to the normal ladder
const PROVIDER_DEATH_BACKOFF_MS = 500; // short backoff before provider-death requeue
const NO_TRAILER_DEMOTION_STREAK = 2; // OBS-57: consecutive no-trailer windows demote a channel for the rest of the run

async function commitsAheadOf(base: string, wt: string): Promise<string[]> {
  const head = await gitHead(wt);
  if (head === base) return [];
  const r = await shGit(`git log --reverse --format=%H ${shq(base)}..${shq(head)}`, wt);
  if (r.code !== 0) return [];
  return r.stdout.trim().split("\n").filter(Boolean);
}

async function cherryPickCommits(wt: string, commits: string[]): Promise<string[]> {
  const carried: string[] = [];
  for (const hash of commits) {
    const r = await shGit(`git cherry-pick --no-gpg-sign ${shq(hash)}`, wt);
    if (r.code !== 0) {
      await shGit("git cherry-pick --abort", wt);
      break;
    }
    carried.push(hash);
  }
  return carried;
}

export async function runDaemon(repoRoot: string, opts: RunOptions = {}): Promise<RunSummary> {
  // v1.51 T2 / OBS-89 (v1.60): retired --quality env seam. Mode resolution owns premium routing;
  // route() no longer reads the retired env at all, so the old entrypoint scrub is gone with it.
  const adapters = opts.adapters ?? allAdapters();
  const health = readDoctor(repoRoot) ?? (await probeAll(adapters));
  const driver: ExecutorDriver = opts.driver ?? new SubprocessDriver();

  // HARD-01/02: hold the run lock across the whole read-modify-write of graph.json. Acquire
  // BEFORE loadGraph; release in the finally below (every exit path, incl. throws).
  const runId = opts.runId ?? newRunId();
  // v1.53 T5: an unknown --supersedes id must fail BEFORE any run starts — Journal.open throws and
  // no lock, journal, or baseline for the new run has been created yet. Opened without a narrate
  // sink: the prior journal append below is silent bookkeeping, not this run's narration.
  const prior = opts.supersedes !== undefined ? Journal.open(repoRoot, opts.supersedes) : undefined;
  // T6 narrator: one live status surface per run (herdr only — driver.narrator is undefined on
  // subprocess, so the optional-chain open below is a no-op there). Cosmetic-only: any failure is
  // swallowed (never affects the run); the operator closes a surviving watch pane.
  const lock = acquireRunLock(repoRoot, runId);
  // v1.54 T2: declared before the try so the finally can always deregister (a throw before
  // registration leaves it undefined — the guard below covers that path).
  let onTermination: ((sig: NodeJS.Signals) => void) | undefined;
  try {
  let graph = loadGraph(repoRoot);
  // v1.51 T2: the routing mode resolves BEFORE any routing input is built — run flag > spec front-matter
  // > repo > global > default. The resolved cfg carries mode-compiled floors; route() never sees the mode.
  const rm = resolveRunMode(repoRoot, { flag: opts.mode, spec: graph.mode, globalDir: opts.globalDir });
  const cfg = rm.cfg;
  // v1.51 T4: every dispatch provenance line begins with the mode and its source; when a pin won
  // the route (the final "→ " segment is a pin, not a degraded-to-auto tail) it names the mode it bypassed.
  const dispatchProvenance = (p: string): string =>
    `mode ${rm.mode.mode} (${rm.source})${p.split("→ ").pop()!.startsWith("pin ") ? ` — pin bypasses mode ${rm.mode.mode}` : ""} · ${p}`;
  const channels = discoverChannels(cfg, adapters, health);
  // v1.6 ROUTE-06: build the learned profile ONCE at startup (never per task, never in the comparator).
  // No preview — the daemon honors routing.learned:off and gets undefined; this snapshot is immutable
  // for the run, so this run's own telemetry never feeds back into its own routing.
  const profile = loadRoutingProfile(repoRoot, cfg);

  // v1.54 T2 (OBS-71): signal reaper — a killed daemon closes its own panes and releases the lock.
  // Every slot this run opens stays in liveSlots until closed: the worker path opens through
  // trackedDriver below, and gates/consults receive trackedDriver as THEIR driver, so their pane
  // opens/closes keep the ledger exact. Termination then closes exactly what is still live — and a
  // slot closed once (task-done, quota reroute, gate self-clean) can never be closed twice.
  const liveSlots = new Set<Slot>();
  const closeSlot = async (s: Slot): Promise<void> => {
    if (!liveSlots.delete(s)) return; // already closed — never twice
    await driver.close(s);
  };
  const trackedDriver: ExecutorDriver = {
    id: driver.id,
    interactive: driver.interactive,
    slot: async (cwd, name, o) => { const s = await driver.slot(cwd, name, o); liveSlots.add(s); return s; },
    run: (s, cmd) => driver.run(s, cmd),
    waitOutput: (s, p, ms, o) => driver.waitOutput(s, p, ms, o),
    waitAgentStatus: (s, st, ms) => driver.waitAgentStatus(s, st, ms),
    status: (s) => driver.status(s),
    read: (s, n) => driver.read(s, n),
    ...(driver.sendKey ? { sendKey: driver.sendKey.bind(driver) } : {}),
    notify: (m, o) => driver.notify(m, o),
    close: closeSlot,
    worktree: (r, b, base) => driver.worktree(r, b, base),
  };
  // Termination (SIGINT/SIGTERM): close every live slot, reconcile owned panes against an EMPTY
  // desired set (herdr panes not in memory; panesToClose spares foreign names, watch panes, and
  // other runs' panes by construction), release the run lock, then exit. Journal-silent by design —
  // no run-end/interrupted event, so stop-amend-resume keeps resuming. keepPanes:"forever" (the
  // keep-everything debug override) preserves panes but still releases the lock and exits.
  let termSignal: NodeJS.Signals | undefined;
  let abortRun: (err: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { abortRun = reject; });
  aborted.catch(() => { /* pre-handled: a signal after the loop drained must not crash as unhandled */ });
  let reaping = false;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  onTermination = (sig: NodeJS.Signals) => {
    termSignal = sig;
    void (async () => {
      if (!reaping) {
        reaping = true;
        if (cfg.visibility.keepPanes !== "forever") {
          for (const s of liveSlots) { // closeSlot only deletes the element being visited — safe during Set iteration
            try { await closeSlot(s); } catch { /* cosmetic — reconcile is the backstop */ }
          }
          try { await driver.reconcile?.(new Set(), runId); } catch { /* cosmetic — visibility is never a gate */ }
        }
        releaseRunLock(repoRoot); // the process dies at exit() below — the finally never runs on this path
      }
      abortRun(new Error(`terminated by ${sig}`));
      exit(sig === "SIGINT" ? 130 : 143);
    })();
  };
  process.on("SIGINT", onTermination);
  process.on("SIGTERM", onTermination);

  const journal = opts.resume ? Journal.open(repoRoot, runId, opts.narrate) : Journal.create(repoRoot, runId, opts.narrate);
  const branchEvent = opts.resume
    ? [...journal.read()].reverse().find((e) => (e.event === "run-start" || e.event === "run-end" || e.event === "merge") && typeof e.data.branch === "string")
    : undefined;
  const recordedBranch = typeof branchEvent?.data.branch === "string" ? branchEvent.data.branch : undefined;
  const branch = recordedBranch
    ? branchEvent!.event === "merge" ? recordedBranch.slice(0, recordedBranch.lastIndexOf("--")) : recordedBranch
    : integrationBranch(cfg, runId);
  if (lock.reclaimed) journal.append("lock-reclaimed", undefined, lock.reclaimed); // HARD-02 audit trail
  // GATE-08 (v1.12): the humanGate guard consults this run's journaled approvals, not just the compiled
  // flag. Built ONCE at startup from the journal; a fresh run's journal is empty ⇒ empty set ⇒ unapproved
  // gates park exactly as today. (D-02 step 3 — the load-bearing change: a command + event WITHOUT this
  // guard change ships a no-op; the task replays to pending, re-enters execTask, and re-parks.)
  const approved = new Set(journal.read().filter((e) => e.event === "task-approved" && e.taskId).map((e) => e.taskId as string));
  const commands = detectGateCommands(repoRoot, cfg);

  let baseRef: string;
  let baseline: Baseline;
  // Phase 46 (RES-01/RES-02): the resume-state map is built ONCE here so execTask closes over it.
  // Empty Map on fresh runs — every seed below conditions on resume.get(t.id), never on opts.resume (the
  // GATE-08 lesson at the humanGate guard: condition on the data, not the code path). Dead-code
  // equivalence to the router.ts:194 profile⇒undefined pattern: no map entry ⇒ today's literal.
  const resume = opts.resume ? journal.replayResumeState() : new Map<string, ResumeState>();
  if (opts.resume) {
    // v1.53 T5: a superseded run is dead — resuming it beside its successor is the exact
    // two-concurrent-runs hazard supersession exists to prevent. Fail closed, naming the successor.
    const superseded = [...journal.read()].reverse().find((e) => e.event === "superseded" && typeof e.data.by === "string");
    if (superseded) throw new Error(`refusing to resume ${runId}: superseded by ${superseded.data.by as string}`);
    const start = journal.read().find((e) => e.event === "run-start");
    if (!start) throw new Error(`journal for ${runId} has no run-start event`);
    baseRef = start.data.baseRef as string;
    // T3 (Sol #2 / Fable F2): refuse to replay this journal's task states onto a graph it does not
    // belong to — overlapping ids would inherit foreign done/human/approval state, missing ids throw.
    // The SAME comparator status uses (engagementComparable); one decision, two consumers. Fail closed:
    // no resume path silently accepts a mismatched or unbound journal. --graph-changed is the operator's
    // audited release for the stop-amend-resume workflow, journaling a graph-rehash naming both hashes.
    const loadedHash = graphDefinitionHash(graph);
    const cmp = engagementComparable(journal.read(), loadedHash);
    if (!cmp.comparable) {
      if (!opts.graphChanged) {
        throw new Error(cmp.reason === "unbound"
          ? `refusing to resume ${runId}: journal has no recorded graph definition hash (older tickmarkr) — pass --graph-changed to override`
          : `refusing to resume ${runId}: graph changed since this run (recorded ${cmp.recorded} ≠ loaded ${loadedHash}) — pass --graph-changed to override`);
      }
      journal.append("graph-rehash", undefined, {
        from: cmp.reason === "mismatch" ? cmp.recorded : null,
        to: loadedHash,
      });
    }
    baseline = JSON.parse(readFileSync(join(journal.dir, "baseline.json"), "utf8"));
    for (const [id, st] of journal.replayStatuses()) {
      // operator release: a graph.json edit back to "pending" beats a replayed human/failed park (locked decision 12)
      if ((st === "human" || st === "failed") && getTask(graph, id).status === "pending") continue;
      graph = setStatus(graph, id, st);
    }
    journal.append("run-resume", undefined, { pid: process.pid }); // v1.13 (VIS-11): record the live daemon pid for status liveness
  } else {
    baseRef = await gitHead(repoRoot);
    baseline = await captureBaseline(repoRoot, commands);
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline, null, 2));
    journal.append("run-start", undefined, { pid: process.pid, baseRef, commands, channels: channels.map(channelKey), branch, graphDefinitionHash: graphDefinitionHash(graph), mode: rm.mode.mode, modeSource: rm.source, ...(prior ? { supersedes: prior.runId } : {}) }); // graphDefinitionHash: T3 engagement identity (status+resume share it); pid: v1.13 (VIS-11) liveness; mode/modeSource: v1.51 T2; supersedes: v1.53 T5
    // v1.53 T5: mark the prior run AFTER this run's run-start exists, so the prior journal never
    // names a successor that has no journal. Append-only — the prior journal is never rewritten.
    prior?.append("superseded", undefined, { by: runId });
  }

  // T6: open the narrator AFTER run-start/run-resume is journaled so the watch surface has a run to
  // show. driver.narrator is undefined on subprocess → no-op (subprocess spawns nothing). Swallowed:
  // a failed-to-open or later-dead watch pane never affects the run.
  try {
    await driver.narrator?.(repoRoot, "tickmarkr status --watch", runId);
  } catch {
    /* cosmetic-only — the run proceeds without a live surface */
  }

  const intWt = await ensureIntegration(repoRoot, branch, baseRef);
  const concurrency = opts.concurrency ?? cfg.concurrency;

  // v1.1 visibility: role-named slots; panes persist per keepPanes (attempt = v1 close-after-harvest)
  const keepOpen = cfg.visibility.keepPanes !== "attempt";
  // D-07 (HYG-09) fleet hygiene — ephemeral panes self-clean + done means gone. keepLlm decouples the
  // judge/review/consult panes from the worker-oriented keepOpen: they close when their result is read
  // unless the operator opts into "forever" (the keep-everything debug override). Reproduces the
  // leftover-judge-pane incident (under keepPanes:"run" the run-end sweep left them open until the end).
  const keepForever = cfg.visibility.keepPanes === "forever";
  const keepLlm = keepForever;
  const keptSlots: Slot[] = [];
  const runTag = runId.replace(/^run-/, ""); // full date-time — cross-run unique even across days
  // OBS-57: per-run in-run demotion — channels that burn consecutive no-trailer windows route around for later attempts.
  const demotedChannels = new Set<string>();
  const noTrailerStreak = new Map<string, number>();

  // OBS-17 T2: reconcile at every safe point — run start/resume (just journaled above), each task
  // terminal event, and run-end. The desired set is the pure journal fold (reconcile.ts); the driver
  // owns listing/parsing/closing. Cosmetic by contract: failures are swallowed and subprocess has no
  // reconcile (optional chain → no-op), so gates and the oracle suite never feel this. keepPanes
  // "forever" is the keep-everything debug override — it disables the sweep entirely.
  const reconcile = async (opts?: { spareLiveLlm?: boolean }) => {
    if (keepForever) return;
    try {
      await driver.reconcile?.(desiredPanes(journal.read(), runId), runId, opts);
    } catch {
      /* cosmetic — visibility is never a gate */
    }
  };
  await reconcile(); // run start/resume boundary: nothing in flight — full sweep, incl. older runs' leftovers

  // v1.4 self-reference guard: a random nonce on the worker trailer AND exit marker. Displayed
  // source/diffs (e.g. a worker editing tickmarkr's own prompt.ts/daemon.ts) can't know it, so an echoed
  // TICKMARKR_RESULT/TICKMARKR_EXIT literal can never premature-harvest the worker. Quote-split keeps the
  // echoed command line itself from matching the marker it prints.
  //
  // v1.13 (VIS-09 safety, 43-02): the nonce is per-ATTEMPT, declared at the top of the attempt loop
  // below — NOT here at run scope. A run-scoped nonce is a latent hazard: HerdrDriver.read() is
  // `pane read --lines 1000` over scrollback and SubprocessDriver never clears s.buf, so any transcript
  // retention across attempts would let attempt N harvest attempt N-1's TICKMARKR_RESULT out of scrollback
  // as its OWN completion — silently LYING about a worker's outcome. Pinned by the stale-trailer oracle
  // in tests/run/daemon.test.ts ("a retained prior-attempt trailer cannot complete a retry"); a future
  // hoist back to run scope reddens it.
  // merges are serialized — two concurrent `git merge`s in one worktree would corrupt each other
  let mergeChain: Promise<unknown> = Promise.resolve();
  const mergeSerial = (taskBranch: string, t: Task, gated: string) => {
    const next = mergeChain.then(() => mergeTask(intWt, taskBranch, `tickmarkr: merge ${t.id} ${t.title}`, gated));
    mergeChain = next.catch(() => undefined);
    return next;
  };

  // gateFails/consults are execTask-scoped counters passed in so a park row is a rich verified-failure
  // observation (e.g. ladder-exhausted + gateFails:4); every task-human row has a closed kind, never prose alone.
  const park = async (t: Task, reason: string, kind: ParkKind, assignment: Assignment | null, attempts: number, startMs: number, gateFails = 0, consults = 0, tokens?: TokenUsage, metered = 0, retryMode: RetryMode = "fresh") => {
    graph = setStatus(graph, t.id, "human");
    saveGraph(repoRoot, graph);
    journal.append("task-human", t.id, { reason, kind });
    if (assignment) {
      journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts, outcome: "human", durationMs: Date.now() - startMs, parkKind: kind, gateFails, consults, tokens, meteredAttempts: tokens ? metered : undefined, retryMode });
    }
    await reconcile({ spareLiveLlm: true }); // task-human is a terminal event — sweep, sparing sibling tasks' live LLM panes
    await driver.notify(`tickmarkr ${runId}: ${t.id} needs a human — ${reason}`, { tier: "attention" });
  };

  const execTask = async (t: Task): Promise<void> => {
    const startMs = Date.now();
    const taskTimeoutMinutes = t.timeoutMinutes ?? cfg.taskTimeoutMinutes;
    if (t.humanGate && !approved.has(t.id)) {
      // GATE-08: the condition is the APPROVAL, never the code path. `!opts.resume` (or any run-phase
      // term) would silently dispatch every unapproved gate that becomes ready during a resume — pinned
      // by the resume-path guard pin in tests/run/daemon.test.ts (the only test that reaches this guard
      // on the resume path; a park-then-resume task is filtered out by readyTasks() and never gets here).
      await park(t, `humanGate: "${t.title}" requires approval before dispatch`, "human-gate", null, 0, startMs);
      return;
    }

    const r = route(t, cfg, channels, profile, undefined, demotedChannels);
    for (const lint of r.lints) journal.append("routing-lint", t.id, { lint });
    // VIS-02: journal a deviation from the static choice ONLY when one occurred (greppable absence = no deviation)
    if (r.deviation) journal.append("route-deviation", t.id, { ...r.deviation, provenance: r.provenance });
    let assignment = r.assignment;
    // Phase 46 (RES-01/RES-02, incident run-20260711-185020 L57-58): resume continues the escalation
    // ladder. Replaying `tried` alone does NOT fix the incident — the first post-resume assignment comes
    // from route() above, which is history-free by design and statically re-picked the consult-banned
    // channel 2 ms after run-resume (daemon.ts:160, the incident's exact mechanism). The override below
    // IS the fix; the tried seed and the attempt-loop start close RES-01/RES-02 alongside it.
    //
    // v1.24 OBS-18: a task-approved{release:attempt-cap} zeros rs.attempts (fresh budget) and clears
    // lastAssignment while keeping tried. Only restore lastAssignment when attempts > 0 — after a
    // fresh-budget release, prefer nextChannel over the surviving tried-list so burned channels are
    // not re-tried first (consult bans / prior failovers survive the release).
    const rs = resume.get(t.id);
    if (rs?.lastAssignment && rs.attempts > 0 && channels.some((c) => channelKey(c) === channelKey(rs.lastAssignment!))) {
      assignment = rs.lastAssignment; // restore the consult-chosen assignment (bypasses route()'s static re-pick)
    } else if (rs && rs.tried.length) {
      // trailing-reroute edge (kill between verdict and dispatch), a stale fleet, OR a fresh-budget
      // release (attempts 0 + non-empty tried): pick a failover over the replayed exclusions via the
      // EXISTING nextChannel `tried` parameter — zero router changes (D-03).
      const next = nextChannel(assignment, t, cfg, channels, rs.tried, profile, demotedChannels);
      if (next) assignment = next;
      // ponytail: nextChannel null (every channel already tried / none available) — keep the static
      // assignment and proceed. Dispatching on a previously-tried channel beats deadlocking a resumed
      // run; a park-instead policy can come later if it ever bites.
    }
    // pre-kill invariant: tried always contains the current assignment. Spread, never alias the
    // journal-derived array (no hidden mutation of replayed state).
    const tried = rs?.tried.length ? [...rs.tried] : [channelKey(assignment)];
    if (!tried.includes(channelKey(assignment))) tried.push(channelKey(assignment));
    // VIS-02 convention: absence = no seeding happened. The observable surface for criterion 2's
    // exclusion-list-equality oracle. Daemon-side append only — no journal.ts write-path change (Phase 48
    // stays unblocked); inert to replayStatuses (unknown events ignored, pinned at journal.test.ts:70-80).
    if (rs) journal.append("resume-restore", t.id, { attempts: rs.attempts, tried: [...tried], assignment });
    const badReviewers: string[] = []; // v1.1: reviewer channels that produced unparseable output for this task
    let feedback = "";
    let ladderIdx = 0;
    let modeFallbackNoted = false; // v1.2: journal the interactive→print fallback once per task, not per attempt
    let gateFails = 0; // TEL-02: incremented ONLY where feedback is built from failing gates — never derived from attempts (quota failovers bump attempts too, Pitfall 6)
    let consults = 0; // TEL-02: bumped in the runConsult wrapper so one counter covers all three trigger sites, across the attempt loop
    let tokens: TokenUsage | undefined; // SPEND-02: accumulated across attempts — parked spend is still spend
    let metered = 0; // SPEND-02: attempts that returned a usage record; distinguishes unmetered from measured-zero
    let tipMoves = 0; // OBS-15: one re-gate allowance per task, never reset by a worker retry
    let retryMode: RetryMode = "fresh";
    let lastContextTokens: number | undefined; // v1.23 reset signal, including stalled/quota attempts
    // v1.29: only a gate-failed attempt can seed same-session retry. The next attempt consumes this
    // once; a changed channel, unknown context, or missing resumeCommand falls back to fresh.
    let retrySession: { channel: string; id: string; contextTokens?: number } | undefined;

    // ROUTE-13: learned within-band failover + deviation audit. nextChannel stays pure (route/ never
    // journals); the daemon compares the learned pick against the static pick and owns the journal write.
    const failover = (site: "consult-reroute" | "quota-failover" | "escalate"): Assignment | null => {
      const next = nextChannel(assignment, t, cfg, channels, tried, profile, demotedChannels);
      if (profile && next) {
        const staticNext = nextChannel(assignment, t, cfg, channels, tried, undefined, demotedChannels);
        if (staticNext && channelKey(next) !== channelKey(staticNext)) {
          journal.append("failover-deviation", t.id, { site, static: channelKey(staticNext), chosen: channelKey(next) });
        }
      }
      return next;
    };

    const runConsult = (trigger: string, transcript: string, diffOrFeedback: string, gates: GateResult[]) => {
      consults++;
      return consult(
        {
          taskId: t.id, trigger,
          journalTail: JSON.stringify(journal.read().slice(-20)),
          transcript: transcript.slice(-8000),
          diff: diffOrFeedback, gates,
        },
        cfg, adapters, trackedDriver, repoRoot, journal.dir,
        // D-07: consult panes self-clean when the verdict is read (keepLlm) — only "forever" keeps them.
        // v1.54 T1: channels = this run's doctor-filtered live list — consult.prefer seat liveness
        // is judged against it, never rebuilt from config (installed-but-unauthed seats would stall).
        { keep: keepLlm, onSlot: keepLlm ? (s: Slot) => keptSlots.push(s) : undefined, runId, channels },
      );
    };

    // returns true → continue attempting, false → task is terminal (parked)
    // trigger (why the consult ran) is threaded in so the decompose/human park keeps its cause —
    // rows 6/10/11 of the mapping (gate-fail vs stall vs merge-conflict) would otherwise conflate.
    const applyVerdict = async (v: ConsultVerdict, attempts: number, trigger: ParkKind): Promise<boolean> => {
      journal.append("consult-verdict", t.id, {
        action: v.action, notes: v.notes,
        ...(v.reason ? { reason: v.reason } : {}),
        ...(v.guidance ? { guidance: v.guidance } : {}),
        ...(v.excludeAdapter ? { excludeAdapter: v.excludeAdapter } : {}),
      });
      await driver.notify(`tickmarkr ${runId}: ${t.id} consult verdict: ${v.action}`, { tier: "attention" });
      if (v.action === "retry") {
        feedback = renderRetryGuidance(v) || feedback;
        return true;
      }
      if (v.action === "reroute") {
        // OBS-20 / v1.24 T1: adapter-scoped exclusion for environmental CLI failures. Expand the
        // task-local tried list with every available channel of the named adapter, then reuse
        // nextChannel's existing tried parameter — zero router changes (D-03). Unknown adapter
        // (zero matches) is a no-op expansion ⇒ ordinary channel-level reroute. Task-scoped:
        // `tried` lives inside execTask, so a sibling task is unaffected.
        if (v.excludeAdapter) {
          for (const c of channels) {
            if (c.adapter === v.excludeAdapter) {
              const k = channelKey(c);
              if (!tried.includes(k)) tried.push(k);
            }
          }
        }
        const next = failover("consult-reroute");
        if (next) {
          assignment = next;
          tried.push(channelKey(next));
          return true;
        }
        await park(t, "consult said reroute but every channel is exhausted", "reroute-exhausted", assignment, attempts, startMs, gateFails, consults, tokens, metered, retryMode);
        return false;
      }
      await park(t, `consult verdict: ${v.action} — ${v.notes}`, trigger, assignment, attempts, startMs, gateFails, consults, tokens, metered, retryMode); // decompose|human
      return false;
    };

    // Phase 46 (RES-01): start at the replayed attempt count; a replayed count ≥ MAX_ATTEMPTS parks via
    // the existing attempt-cap check below with zero new code. Fresh path: rs is undefined ⇒ 0.
    // v1.24 OBS-18: after task-approved{release:attempt-cap}, replay zeros attempts so this loop
    // starts at 0 (fresh budget) instead of re-parking at the cap in the same tick.
    let providerDeathRequeues = 0;
    let providerDeathAttempt = -1;
    attempts: for (let attempt = rs?.attempts ?? 0; ; attempt++) {
      if (attempt !== providerDeathAttempt) {
        providerDeathRequeues = 0;
        providerDeathAttempt = attempt;
      }
      // v1.13 (VIS-09 safety): one FRESH nonce per attempt — see the run-scope comment above. A retained
      // prior-attempt trailer (herdr scrollback / subprocess buffer) must never satisfy this attempt.
      const nonce = randomBytes(4).toString("hex");
      const exitMarkerCmd = `printf '\\nTICKMARKR_''EXIT_${nonce}:%s\\n' $?`;
      const exitRe = new RegExp(`TICKMARKR_EXIT_${nonce}:(\\d+)`);
      if (attempt >= MAX_ATTEMPTS) {
        await park(t, `attempt cap (${MAX_ATTEMPTS}) reached`, "attempt-cap", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      // OBS-57: a demoted channel must not be re-dispatched on consult retry or provider requeue.
      if (demotedChannels.has(channelKey(assignment))) {
        const next = nextChannel(assignment, t, cfg, channels, tried, profile, demotedChannels);
        if (next) {
          assignment = next;
          const k = channelKey(next);
          if (!tried.includes(k)) tried.push(k);
        }
      }
      // v1.29: consume the prior gate-failed session once. Same channel + known under-threshold context
      // + adapter capability resumes; every other path is today's fresh dispatch.
      // v1.53 T3: an adapter with no context surface at all (kimi, KIMI-03) may declare
      // resumeUnknownContext to loosen ONLY the contextTokens-known requirement — a KNOWN
      // over-threshold context still forces fresh, and the escalation ladder bounds the chain.
      const priorSession = retrySession;
      retrySession = undefined;
      const retryAdapter = adapters.find((a) => a.id === assignment.adapter);
      retryMode = priorSession
        && priorSession.channel === channelKey(assignment)
        && (priorSession.contextTokens !== undefined
          ? priorSession.contextTokens < cfg.contextWarnTokens
          : retryAdapter?.resumeUnknownContext === true)
        && retryAdapter?.resumeCommand
        ? "resume"
        : "fresh";
      // v1.23 T3: over-threshold context still forces fresh at the retry boundary; never interrupt a
      // running attempt. Unknown/below emits no reset event.
      if (attempt > 0 && lastContextTokens !== undefined && lastContextTokens >= cfg.contextWarnTokens) {
        journal.append("session-reset", t.id, {
          tokens: lastContextTokens,
          threshold: cfg.contextWarnTokens,
          attempt, // the fresh attempt about to dispatch
        });
      }
      lastContextTokens = undefined;
      graph = setStatus(graph, t.id, "running");
      saveGraph(repoRoot, graph);
      journal.append("task-dispatch", t.id, { assignment, attempt, provenance: dispatchProvenance(r.provenance), retryMode });

      const taskBase = await integrationHead(intWt); // deps are merged → visible to this task
      const taskBranch = `${branch}--${t.id}`; // "--": a ref can't nest under the existing integration branch (locked decision 10)
      const priorWt = worktreePath(repoRoot, taskBranch);
      const commitsToCarry = existsSync(priorWt) ? await commitsAheadOf(taskBase, priorWt) : [];
      const wt = await driver.worktree(repoRoot, taskBranch, taskBase);
      // OBS-58: quota-failover and every retry recreate the task worktree from the integration tip —
      // cherry-pick prior attempts' landed commits forward so a failover dispatch cannot silently
      // orphan work a consult already verified as landed.
      let carriedCommits: string[] = [];
      if (commitsToCarry.length > 0) {
        carriedCommits = await cherryPickCommits(wt, commitsToCarry);
        journal.append("worktree-recreation", t.id, { attempted: commitsToCarry, carried: carriedCommits });
      }
      const priorNamed = [...new Set([...commitsToCarry, ...carriedCommits])];
      const presentCommits = new Set(carriedCommits);
      for (const h of commitsToCarry) {
        if (!presentCommits.has(h) && (await shGit(`git merge-base --is-ancestor ${shq(h)} HEAD`, wt)).code === 0) {
          presentCommits.add(h);
        }
      }
      if (feedback || priorNamed.length > 0) {
        feedback = augmentRetryBrief(feedback, { attempted: commitsToCarry, carried: carriedCommits, present: presentCommits });
      }
      if (cfg.setup) {
        // v1.22 T3: setup runs inside the task worktree — seal herdr control vars so a setup script
        // cannot mutate the operator's panes. Worker/judge/review/consult are sealed at the driver
        // boundary (SubprocessDriver spawn env / HerdrDriver pane seed); this is the remaining
        // daemon-owned child shell that is not a driver.slot.
        const sr = await sh(`${herdrSealShellPrefix()}${cfg.setup}`, wt, 10 * 60_000);
        journal.append("worktree-setup", t.id, { code: sr.code });
        if (sr.code !== 0) {
          await park(t, `worktree setup failed (exit ${sr.code}): ${cfg.setup}`, "setup", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
      }
      const promptFile = writePrompt(journal.dir, t, attempt, feedback, nonce);
      // OBS-56: state the non-interactive, one-pass finish contract and the OBS-54 stall budget in every
      // worker prompt, not only consult retry guidance. Prepended so prompt.ts's completion trailer stays last.
      const workerContract = `## Harness contract\n- This harness is non-interactive: make one continuous pass; do not stop for questions or follow-up input.\n- You have a ${taskTimeoutMinutes} minute stall window. Budget the full suite once, then commit and emit the completion trailer before it expires.\n- Each test: acceptance criterion must exist as a vitest test whose title matches the criterion string verbatim.`; // OBS-64
      // OBS-47: state the worktree layout contract in the worker prompt (cheap-tier workers were
      // committing/deleting node_modules and tripping the scope gate). The harness re-asserts the link
      // itself before gates regardless of what the worker does with it.
      writeFileSync(promptFile, `${WORKTREE_LAYOUT_CONTRACT}\n\n${workerContract}\n\n${readFileSync(promptFile, "utf8")}`);
      const adapter = getAdapter(assignment.adapter, adapters);

      // VIS-04: workers share one role tab. T2: `owned` names the pane canonically (ownership contract);
      // the legacy name stays the fallback for drivers without owned handling (subprocess spies).
      const slot = await trackedDriver.slot(wt, `${t.id}-worker-${assignment.adapter}-a${attempt}-${runTag}`, { group: "workers", owned: { role: "worker", taskId: t.id, attempt, runId } });
      const sessionId = retryMode === "resume" ? priorSession!.id : slot.name;
      const icmd = retryMode === "resume"
        ? adapter.resumeCommand!(sessionId, promptFile, assignment.model)
        : cfg.visibility.worker === "interactive" && driver.interactive
          ? adapter.interactiveCommand(promptFile, assignment.model)
          : null;
      if (cfg.visibility.worker === "interactive" && icmd === null && !modeFallbackNoted) {
        modeFallbackNoted = true;
        journal.append("worker-mode-fallback", t.id, { reason: driver.interactive ? "adapter" : "driver" });
      }

      const interactive = icmd !== null;
      // OBS-85 (v1.62 T1): both dispatch branches deliver ONE short script invocation — banner,
      // adapter command, and nonce exit marker live in a per-attempt script beside the prompt
      // artifact (the same paneDispatchCommand pattern judge/review/consult dispatches use). The
      // delivered pane line carries no command substitution and no trailing shell text, so paste
      // timing can never interleave a `$(…)` with what follows it (the codex corruption class).
      const workerCmd = interactive ? icmd : adapter.invoke(t, wt, assignment, { promptFile }).command;
      const dispatchScript = promptFile.replace(/\.md$/, ".sh");
      writeFileSync(dispatchScript, [
        "export BASH_SILENCE_DEPRECATION_WARNING=1",
        bannerShell(),
        workerCmd,
        exitMarkerCmd,
      ].join("\n"));
      // SPEND-01: this attempt's dispatch wall-clock — the usage collect cursor. Captured once here, the
      // single site, so a test can reason about it; keep Date.now() out of profile.ts (still pure) and
      // out of adapter module scope (the cursor is a parameter, threaded from the daemon).
      const attemptStart = Date.now();
      // v1.23 T2: once-per-attempt latch for context threshold crossing. Sample ONLY at existing poll
      // seams (interactive wait slices) — never a new timer loop. null/unknown usage fails OPEN
      // (never treated as over-threshold). Journal + notify fire at most once while the value stays high.
      let contextWarned = false;
      let contextTokens: number | undefined;
      const sampleContext = async () => {
        if (contextWarned || !adapter.contextUsage) return;
        let usage: { tokens: number; limit?: number } | null = null;
        try {
          // SessionRef id stays stable across resume attempts; adapters return null on a store miss.
          usage = adapter.contextUsage({ cwd: wt, id: sessionId });
        } catch {
          return; // fail-open: a broken reader never blocks the attempt
        }
        if (!usage || typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens)) return;
        contextTokens = usage.tokens; // last known valid sample, including under-threshold resume candidates
        if (usage.tokens < cfg.contextWarnTokens) return;
        contextWarned = true;
        lastContextTokens = usage.tokens;
        journal.append("context-sample", t.id, {
          tokens: usage.tokens,
          ...(usage.limit !== undefined ? { limit: usage.limit } : {}),
          threshold: cfg.contextWarnTokens,
          attempt,
        });
        await driver.notify(
          `tickmarkr ${runId}: ${t.id} context ${usage.tokens} tokens ≥ ${cfg.contextWarnTokens}`,
          { tier: "attention" },
        );
      };
      let finished: boolean;
      let output: string;
      let exitCode: number | null;
      let timedOut = false;
      if (interactive) {
        // v1.2 interactive: the TUI doesn't exit on completion — the trailer is the finish line.
        // The exit wrapper still fires if the TUI dies (crash/quit): fast-fail instead of burning the timeout.
        await driver.run(slot, paneDispatchCommand(dispatchScript));
        let paged = false;
        // v1.22 T5 / OBS-19: auto-answer a fingerprint-matched trust dialog exactly once per slot.
        // Any other blocked/idle dialog still pages the operator (paged latch below).
        let trustAnswered = false;
        finished = false;
        exitCode = null;
        output = await driver.read(slot, 1000);
        // OBS-54: reaping keys on new pane output, not dispatch wall clock. Poll at least twice per
        // stall window (and at the existing 30s cadence for normal windows) so an active worker resets it.
        const stallWindowMs = taskTimeoutMinutes * 60_000;
        // OBS-82: the stall clock compares NORMALIZED snapshots so a spinner glyph/elapsed-time
        // repaint is silence, not activity. ONLY this inactivity compare sees normalized text —
        // trailer detection, harvest, paging, and quota checks all read the raw pane.
        let lastStallSnapshot = normalizeStallSnapshot(output);
        let lastOutputAt = Date.now();
        while (Date.now() - lastOutputAt < stallWindowMs) {
          const sliceStart = Date.now();
          const remaining = stallWindowMs - (sliceStart - lastOutputAt);
          const slice = Math.min(BLOCKED_POLL_MS, Math.max(100, Math.min(stallWindowMs / 2, remaining)));
          if (await driver.waitOutput(slot, `(${trailerPattern(nonce)})|TICKMARKR_EXIT_${nonce}:\\d`, slice, { regex: true })) {
            // verify before accepting: a worker that merely DISPLAYS a marker (e.g. editing tickmarkr's
            // own source, where "TICKMARKR_EXIT:" is a string literal) must not end the wait. Only a
            // parseable trailer or a digit-suffixed exit marker in the harvest is completion.
            output = await driver.read(slot, 1000); // TUI transcripts carry chrome — read deeper than print's 500
            finished = new RegExp(trailerPattern(nonce)).test(output);
            const exit = exitRe.exec(output);
            if (finished || exit) {
              exitCode = exit ? Number(exit[1]) : null; // null ⇔ the TUI is still alive
              await sampleContext(); // final poll-seam sample before leaving the wait
              break;
            }
          }
          const currentStallSnapshot = normalizeStallSnapshot(await driver.read(slot, 1000));
          if (currentStallSnapshot !== lastStallSnapshot) {
            lastStallSnapshot = currentStallSnapshot;
            lastOutputAt = Date.now();
          }
          // v1.23 T2: piggyback on this poll slice — same cadence as blocked/idle checks, no new timer.
          await sampleContext();
          // page on "idle" too: herdr's blocked-scrape is strict and proved flaky for TUI dialogs
          // (live check: cursor's trust dialog scraped as idle). "unknown" never pages — that's just
          // a pane the scraper can't read (subprocess, dead pane); the task timeout covers those.
          const st = paged ? "" : await driver.status(slot);
          if (!paged && (st === "blocked" || st === "idle")) {
            // T5: once-per-slot auto-answer when the adapter declares a trust dialog and the pane
            // text matches. tickmarkr created the worktree from the operator's own repo — safe by construction.
            if (!trustAnswered && adapter.trustDialog && driver.sendKey) {
              try {
                const paneText = await driver.read(slot, 80);
                if (matchesTrustDialog(paneText, adapter.trustDialog)) {
                  trustAnswered = true;
                  // v1.25 T1: audit trail for live runs — prove the dialog appeared and was answered.
                  // Latch + sendKey + no-page continue stay byte-identical; this append is additive only.
                  journal.append("trust-auto-answer", t.id, { slot: slot.name, adapter: adapter.id });
                  await driver.sendKey(slot, adapter.trustDialog.key);
                  const spent = Date.now() - sliceStart;
                  if (spent < slice) await new Promise((r) => setTimeout(r, Math.min(slice - spent, 1_000)));
                  continue; // do not page — keep waiting for the trailer
                }
              } catch {
                /* read/send failed — fall through to page the operator */
              }
            }
            paged = true; // page once — the visible pane is the operator's to unblock; task timeout is the backstop
            const why = st === "blocked" ? "is blocked on a prompt — approve in its pane" : "looks idle without finishing — check its pane";
            await driver.notify(`tickmarkr ${runId}: ${slot.name} ${why}`, { tier: "attention" });
          }
          // a dead pane or a false-positive marker display returns fast — sleep the unspent slice, never hot-spin
          const spent = Date.now() - sliceStart;
          if (spent < slice) await new Promise((r) => setTimeout(r, Math.min(slice - spent, 1_000)));
        }
        if (!finished && exitCode === null) {
          // timed out (or only ever saw false positives): harvest whatever the pane holds now
          timedOut = Date.now() - lastOutputAt >= stallWindowMs;
          output = await driver.read(slot, 1000);
          finished = new RegExp(trailerPattern(nonce)).test(output);
          const exit = exitRe.exec(output);
          exitCode = exit ? Number(exit[1]) : null;
        }
        if (finished) {
          await driver.waitAgentStatus(slot, "idle", 5_000); // settle, then re-harvest the final render
          output = await driver.read(slot, 1000);
        }
      } else {
        await driver.run(slot, paneDispatchCommand(dispatchScript));
        // OBS-54: headless workers have the same output-inactivity budget as visible panes.
        // OBS-82: same normalized-snapshot compare as the interactive site — spinner-only repaints
        // exhaust the budget here too; harvest below still reads the raw pane.
        const stallWindowMs = taskTimeoutMinutes * 60_000;
        let lastStallSnapshot = normalizeStallSnapshot(await driver.read(slot, 500));
        let lastOutputAt = Date.now();
        finished = false;
        while (Date.now() - lastOutputAt < stallWindowMs) {
          const remaining = stallWindowMs - (Date.now() - lastOutputAt);
          const slice = Math.min(BLOCKED_POLL_MS, Math.max(100, Math.min(stallWindowMs / 2, remaining)));
          if (await driver.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, slice, { regex: true })) {
            finished = true;
            break;
          }
          const currentStallSnapshot = normalizeStallSnapshot(await driver.read(slot, 500));
          if (currentStallSnapshot !== lastStallSnapshot) {
            lastStallSnapshot = currentStallSnapshot;
            lastOutputAt = Date.now();
          }
        }
        output = await driver.read(slot, 500);
        exitCode = Number(exitRe.exec(output)?.[1] ?? 1);
        timedOut = !finished && Date.now() - lastOutputAt >= stallWindowMs;
      }
      // SPEND-01 interactive metering race: the harvest loop breaks on the trailer, but the worker
      // shell may still be running post-trailer bookkeeping (session-store flush, fake usage stamp,
      // exit wrapper). Print mode already waits for TICKMARKR_EXIT, which follows that tail; drain
      // interactive attempts to the same exit marker before close and the post-hoc usage disk read
      // so a writer never races the reader (real CLIs can flush usage asynchronously after the trailer).
      if (interactive && finished && !exitRe.test(output)) {
        await driver.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, 2_000, { regex: true });
      }
      // keepPanes retains visible context, not a timed-out subprocess tree. Close before consult/retry
      // can recreate the worktree; Herdr and subprocesses that reached their exit marker stay unchanged.
      if (keepOpen && (finished || driver.id !== "subprocess")) keptSlots.push(slot);
      else await closeSlot(slot);
      // SPEND-01: usage from the harness's own cwd-keyed structured store, read POST-HOC from disk —
      // `wt` is this task's private worktree, so the path is unique; the read is sliced to records
      // stamped at/after this attempt's dispatch instant. Never the harvested pane text, never the
      // parsed worker trailer. No interactive branch: a TUI writes the same store. undefined ⇒ unmetered.
      // SPEND-02: fold this attempt's slice into the task accumulator only when it's a real observation —
      // an absent record leaves `tokens`/`metered` untouched (never a materialized zero).
      const attemptUsage = adapter.collectUsage?.(wt, attemptStart);
      if (attemptUsage) { tokens = addUsage(tokens, attemptUsage); metered++; }
      const result = adapter.parse(output, nonce);
      const cause = classifyWorkerResultCause({ output, ok: result.ok, finished, exitCode, summary: result.summary, timedOut });
      journal.append("worker-result", t.id, {
        ok: result.ok, summary: result.summary, deviations: result.deviations, finished, exitCode,
        mode: interactive ? "interactive" : "print", ...(cause ? { cause } : {}),
      });
      if (result.ok && finished) noTrailerStreak.set(channelKey(assignment), 0);
      else if (!finished && cause !== "provider-death") {
        const ck = channelKey(assignment);
        const streak = (noTrailerStreak.get(ck) ?? 0) + 1;
        noTrailerStreak.set(ck, streak);
        // OBS-57: two consecutive no-trailer windows in one run demote the channel for later attempts.
        if (streak >= NO_TRAILER_DEMOTION_STREAK && !demotedChannels.has(ck)) {
          demotedChannels.add(ck);
          journal.append("channel-demotion", t.id, { channel: ck, streak });
        }
      }

      // v1.46 T1: provider-outage requeue — same assignment, no attempt burn, no consult, capped.
      if (cause === "provider-death" && providerDeathRequeues < PROVIDER_DEATH_REQUEUE_CAP) {
        providerDeathRequeues++;
        journal.append("provider-death-requeue", t.id, { attempt, requeue: providerDeathRequeues, assignment });
        await new Promise((r) => setTimeout(r, PROVIDER_DEATH_BACKOFF_MS));
        attempt--;
        continue;
      }

      // quota exhaustion → failover within floor; does NOT consume the ladder (spec §4)
      // print: guarded on exit code — exit-0 output that merely MENTIONS "rate limit" must not failover
      // interactive: a harvested trailer beats quota mentions; without one, quota text fails over (spec v1.2 §2)
      const quotaHit = (interactive ? !finished : exitCode !== 0) && QUOTA_RE.test(output);
      if (quotaHit) {
        const next = failover("quota-failover");
        journal.append("quota-failover", t.id, { from: channelKey(assignment), to: next ? channelKey(next) : null });
        if (next) {
          await driver.notify(`tickmarkr ${runId}: ${t.id} quota failover`, { tier: "attention" });
          // OBS-17 T2: the superseded slot's pane closes AT REROUTE TIME — it holds a throttled
          // dead-end, not failure context; the next safe-point reconcile catches a missed close.
          if (!keepForever) {
            const idx = keptSlots.indexOf(slot);
            if (idx >= 0) {
              keptSlots.splice(idx, 1);
              try { await closeSlot(slot); } catch { /* cosmetic — reconcile is the backstop */ }
            }
          }
          // v1.8 TEL-05 — FROM-channel attribution for mid-task quota failover: `assignment` is still the
          // throttled-away-FROM channel here (before the reassign below). durationMs:0 marks this as a
          // failover FACT, not a timed attempt. The park branch is deliberately NOT written here — park()
          // already records parkKind:"quota", so writing here too would double-count in Phase 26 ROUTE-12.
          journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts: attempt + 1, outcome: "failed", durationMs: 0, quotaFailover: true, retryMode });
          assignment = next;
          tried.push(channelKey(next));
          continue;
        }
        await park(t, "quota exhausted on every eligible channel", "quota", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      if (!finished) {
        // ROUTE-18 (OBS-04): the channel burned a window without emitting a trailer (no-trailer timeout
        // OR trailer-less crash-exit — both finished:false). durationMs:0 marks a FACT row, not a timed
        // attempt; attributed to the still-current assignment (the TEL-05 quotaFailover:382 shape, field
        // swapped). Strictly AFTER the quota check above — the quota branch returns/continues before
        // reaching here, so a quota hit can never also carry overrun (no double-count). Read side: 48-01.
        journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts: attempt + 1, outcome: "failed", durationMs: 0, overrun: true, retryMode });
        const v = await runConsult(
          "stall",
          output,
          exitCode !== null && interactive
            ? `worker process exited (code ${exitCode}) without a trailer`
            : `no completion marker within ${taskTimeoutMinutes}m`,
          [],
        );
        if (await applyVerdict(v, attempt + 1, "stall")) continue;
        return;
      }

      graph = setStatus(graph, t.id, "gated");
      saveGraph(repoRoot, graph);
      // OBS-47: re-assert the node_modules link BEFORE gates run on any attempt. A worker may have
      // deleted/replaced the symlink provisioned at worktree creation (run-20260717-004803 T5 lost two
      // attempts + a consult to this); restore it harness-side so a prior attempt's environment damage
      // can never fail a later attempt's gates. Gates never trust worker claims — this runs
      // unconditionally, never on worker say-so. Restoration can fail (EPERM/busy); fail closed with a
      // named environmental verdict instead of letting the test gate mask it as a code red.
      if (!linkNodeModules(repoRoot, wt, { force: true })) {
        await park(t, "environmental: node_modules link could not be re-asserted before gates (OBS-47)", "setup", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      const onGate = async (e: GateEvent) => {
        if (e.phase === "start") return;
        const g = e.result;
        // GATE-09 (ROADMAP SC-4): journal every judge retry as an attributable event — which gate flaked,
        // which channel flaked, which channel retried — so `tickmarkr journal`/report can distinguish "judge
        // flaked, retried" from "worker failed" (run-20260711-185020 P43-03 L70-72 billed a judge flake as
        // a worker attempt; 47-01 fixed WHO retries, this closes the audit-trail half). The condition is
        // META-ONLY (D-03): gate === "acceptance" + typeof-shape guards on meta.judgeRetry — never a
        // details-regex. The v1.1 review regex below is grandfathered, not precedent. Appended BEFORE the
        // gate-result so attribution precedes the verdict in the stream. secondUnparseable is derived from
        // the final result's meta.unparseable (set by run-gates when the retry ALSO flaked — double-garbage).
        if (g.gate === "acceptance" && typeof g.meta?.judgeRetry === "object" && g.meta.judgeRetry !== null) {
          const jr = g.meta.judgeRetry as Record<string, unknown>;
          if (typeof jr.flaked === "string" && typeof jr.retried === "string") {
            journal.append("judge-retry", t.id, {
              gate: "acceptance", flaked: jr.flaked, retried: jr.retried,
              ...(g.meta.unparseable === true ? { secondUnparseable: true } : {}),
            });
          }
        }
        journal.append("gate-result", t.id, { gate: g.gate, pass: g.pass, details: g.details, ...(g.meta?.skipped === true ? { skipped: true } : {}) });
        // v1.1 failover: never re-ask a reviewer channel that produced garbage for this task
        if (g.gate === "review" && !g.pass && /unparseable/.test(g.details) && typeof g.meta?.reviewer === "string") {
          badReviewers.push(g.meta.reviewer);
        }
      };
      let results: GateResult[] = [];
      let commits: string[] = [];
      gateLoop: while (true) {
        const gated = await gitHead(wt);
        ({ results, commits } = await runGates(t, {
          worktree: wt, baseRef: taskBase, result, author: assignment,
          commands, baseline, channels, adapters, cfg,
          via: cfg.visibility.llm === "pane"
            ? {
                driver: trackedDriver,
                // D-07: judge/review panes self-clean when their verdict is read (keepLlm) — only "forever" keeps them.
                keep: keepLlm,
                onSlot: keepLlm ? (s: Slot) => keptSlots.push(s) : undefined,
                // T2 ownership contract: canonical names (tickmarkr:<role>:<task>:0:<runId>) so reconcile
                // owns judge/review panes; run-gates' -r1 retry suffix becomes attempt 1 in llm.ts.
                // Same-name reuse across worker attempts is safe: panes self-clean when read (keepLlm),
                // and herdr's DEFECT-01 reclaim covers a kept holdover under keepPanes:forever.
                nameFor: (role) => formatOwnedName({ role, taskId: t.id, attempt: 0, runId }),
                // role-tab label (SUP-01): role-first + task id, unique per concurrent instance within a run.
                // Duplicate labels from a resumed run or operator-made tabs are accepted (per-process state).
                labelFor: (role) => `${role.toUpperCase()} ${t.id}`,
              }
            : undefined,
          excludeReviewers: badReviewers,
          onGate,
        }));
        graph = addEvidence(graph, t.id, { commits, gateResults: results, artifacts: [promptFile] });
        saveGraph(repoRoot, graph);

        if (results.every((g) => g.pass)) {
          const m = await mergeSerial(taskBranch, t, gated);
          if (m.tipMoved) {
            journal.append("tip-moved", t.id, m.tipMoved);
            if (tipMoves++ === 0) continue gateLoop;
            await park(t, "task branch tip moved twice after gating", "tip-moved", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
            return;
          }
          if (!m.ok) {
            journal.append("merge-conflict", t.id, { conflict: m.conflict });
            const v = await runConsult("merge-conflict", output, m.conflict ?? "", results);
            if (await applyVerdict(v, attempt + 1, "merge-conflict")) continue attempts;
            return;
          }
          graph = setStatus(graph, t.id, "done");
          saveGraph(repoRoot, graph);
          journal.append("task-done", t.id, { attempts: attempt + 1, assignment });
          journal.append("merge", t.id, { branch: taskBranch, commit: await integrationHead(intWt) });
          // firstAttemptOk/gateFails/consults are recorded FACTS, not policy — a parkKind:"stall" row is
          // recorded but NOT quality-negative in v1.6; Phase 12 owns reward policy, so flipping it later needs zero data migration.
          journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts: attempt + 1, outcome: "done", durationMs: Date.now() - startMs, firstAttemptOk: attempt === 0, gateFails, consults, tokens, meteredAttempts: tokens ? metered : undefined, retryMode });
          // D-07 done means gone (merged-P42-01-worker incident): a merged task's worker pane closes on
          // the task-done path, not at run end. Only THIS successful attempt's `slot` is in scope — prior
          // failed attempts' slots stay in keptSlots governed by keepPanes (they hold failure context the
          // operator may need). keepPanes:"forever" is the keep-everything debug override. Removing from
          // keptSlots guarantees the run-end sweep cannot double-close; the indexOf guard also covers
          // "attempt" (slot already closed per-attempt at the worker line above) — close only what you own (Pitfall 5).
          if (!keepForever) {
            const idx = keptSlots.indexOf(slot);
            if (idx >= 0) {
              keptSlots.splice(idx, 1);
              await closeSlot(slot);
            }
          }
          await reconcile({ spareLiveLlm: true }); // task-done is a terminal event — sweep this task's leftovers
          return;
        }
        break gateLoop;
      }

      gateFails++; // this attempt's gates failed — the one place quality degradation is verified (never inferred from attempts)
      // v1.53 T3: prefer the CLI's own session id captured from this attempt's output (kimi's resume
      // trailer) over the harness slot name; absent hook or no capture keeps today's slot-name id.
      retrySession = { channel: channelKey(assignment), id: adapter.sessionIdFrom?.(output) ?? sessionId, contextTokens };
      feedback = results.filter((g) => !g.pass).map((g) => `${g.gate}: ${g.details}`).join("\n\n");
      const step = r.ladder[Math.min(ladderIdx++, r.ladder.length - 1)];
      journal.append("escalation", t.id, { step, attempt: attempt + 1 });
      await driver.notify(`tickmarkr ${runId}: ${t.id} escalation: ${step}`, { tier: "attention" });

      if (step === "retry") continue;
      if (step === "escalate") {
        const next = failover("escalate");
        if (next) {
          assignment = next;
          tried.push(channelKey(next));
          continue;
        }
        // no channel left — fall through to a consult
      }
      if (step === "escalate" || step === "consult") {
        const v = await runConsult("gate-fail", output, feedback, results);
        if (await applyVerdict(v, attempt + 1, "gate-fail")) continue;
        return;
      }
      await park(t, "escalation ladder exhausted", "ladder-exhausted", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
      return;
    }
  };

  const inflight = new Map<string, Promise<void>>();
  while (true) {
    // v1.54 T2: a signal that landed while nothing was racing `aborted` (empty inflight window)
    // must still stop the run before it can dispatch more work or write run-end.
    if (termSignal) throw new Error(`terminated by ${termSignal}`);
    const ready = readyTasks(graph)
      .filter((t) => !inflight.has(t.id))
      .slice(0, Math.max(0, concurrency - inflight.size));
    for (const t of ready) {
      const p = execTask(t)
        .catch(async (err) => {
          graph = setStatus(graph, t.id, "failed");
          saveGraph(repoRoot, graph);
          journal.append("task-failed", t.id, { error: String(err) });
          journal.telemetry({ taskId: t.id, shape: t.shape, adapter: "-", model: "-", channel: "-", attempts: 0, outcome: "failed", durationMs: 0 });
          await reconcile({ spareLiveLlm: true }); // task-failed is a terminal event
        })
        .finally(() => inflight.delete(t.id));
      inflight.set(t.id, p);
    }
    if (inflight.size === 0) break;
    await Promise.race([...inflight.values(), aborted]); // aborted rejects on termination — unwinds the run
  }

  // D-07: the sweep now closes only what's LEFT in keptSlots — done-closed worker slots were removed
  // (no double-close) and self-cleaned LLM/consult panes were never added under keepLlm:false. This
  // leaves failed/parked attempts' worker slots, which keep their failure context until run end.
  if (cfg.visibility.keepPanes === "run") {
    for (const s of keptSlots) await closeSlot(s); // panes persist for the run's duration, then clean up
  }

  saveGraph(repoRoot, graph);
  const byStatus = (s: string) => graph.tasks.filter((t) => t.status === s).map((t) => t.id);
  // buckets derived from the graph at summary time (D-01/D-02); the loop has exited with
  // inflight.size === 0, so the five buckets sum to graph.tasks.length by construction.
  const summary: RunSummary = {
    runId,
    branch,
    done: byStatus("done"),
    failed: byStatus("failed"),
    human: byStatus("human"),
    blocked: blockedTasks(graph).map((t) => t.id),
    pending: pendingTasks(graph).map((t) => t.id),
  };

  // OBS-34: post-merge integration-tip verify — strict exit codes, no baseline forgiveness.
  const lastMergedTask = [...journal.read()].reverse().find((e) => e.event === "merge" && e.taskId)?.taskId;
  if (summary.done.length > 0 && Object.keys(commands).length > 0) {
    const tipResults = await verifyIntegrationTip(intWt, commands, journal.dir);
    let tipFailed = false;
    for (const r of tipResults) {
      if (r.pass) {
        journal.append("tip-verify", undefined, { gate: r.gate, cmd: r.cmd, pass: true, exitCode: r.exitCode, details: r.details });
      } else {
        journal.append("tip-verify-failed", undefined, {
          gate: r.gate,
          cmd: r.cmd,
          exitCode: r.exitCode,
          fingerprints: r.fingerprints,
          artifact: r.artifact,
          lastMergedTask,
        });
        tipFailed = true;
      }
    }
    summary.tipVerify = tipFailed ? "failed" : "passed";
    if (tipFailed && lastMergedTask) summary.lastMergedTask = lastMergedTask;
  }

  journal.append("run-end", undefined, { ...summary });
  await reconcile(); // run-end boundary: nothing in flight — full sweep (empty desired set)
  // OBS-28: lingering worktrees starve CLI probes; keepPanes:forever is the debug override.
  if (!keepForever) {
    const green = summary.failed.length === 0 && summary.human.length === 0
      && summary.blocked.length === 0 && summary.pending.length === 0
      && summary.tipVerify !== "failed";
    await cleanupRunWorktrees(repoRoot, branch, { removeIntegration: green, removeTaskIds: summary.done });
  }
  // VIS-02: name each blocked subtree by its nearest parked/failed root, e.g. "3 blocked behind P40-02".
  const attribution = [...attributeBlocked(graph).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([root, count]) => `${count} blocked behind ${root}`)
    .join(", ");
  const tipFail = summary.tipVerify === "failed"
    ? ` — TIP VERIFY FAILED on ${summary.lastMergedTask ? `last merge ${summary.lastMergedTask}` : "integration tip"}`
    : "";
  await driver.notify(
    `tickmarkr ${runId}: ${summary.done.length} done, ${summary.failed.length} failed, ${summary.human.length} awaiting human, ${summary.blocked.length} blocked, ${summary.pending.length} pending${attribution ? ` (${attribution})` : ""}${tipFail} — integration branch ${branch} (merge to main is yours)`,
    { tier: summary.tipVerify === "failed" ? "attention" : "routine" },
  );
  return summary;
  } finally {
    // v1.54 T2: deregister on EVERY exit (normal run end, throw, termination unwind) — the daemon
    // test suite runs runDaemon dozens of times in one process; a leaked handler would close a
    // later run's slots.
    if (onTermination) {
      process.removeListener("SIGINT", onTermination);
      process.removeListener("SIGTERM", onTermination);
    }
    releaseRunLock(repoRoot);
  }
}
