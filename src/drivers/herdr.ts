import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredInputBoxForWorkerName, matchesEmptyInputBox, matchesInputBox, matchesOccupiedInputBox, missingInputStateDeclarations, shq, type InputBox } from "../adapters/types.js";
import { consumePaneLaunchIntent, PANE_IDENTITY_ENV, paneIdentityLine } from "../brand.js";
import { createWorktree, sh } from "../run/git.js";
import { Journal } from "../run/journal.js";
import { herdrSealShellPrefix } from "./subprocess.js";
import { canonicalizeLegacyName, formatOwnedName, panesToClose, parseOwnedName, type ExecutorDriver, type NotifyOpts, type Slot, type SlotOpts } from "./types.js";

// VIS-09 P43-03: adopted safety floor from 43-MEASUREMENT.md (narrowest safe 53 → floor 108).
export const TRAILER_SAFE_FLOOR_COLS = 108;
export const TRAILER_WIDTH_MARGIN = 2; // cols below (floor + margin) refuse a rightward first split

// OBS-85 verified delivery: bounded type→read-back→enter attempts before failing closed.
export const DELIVERY_ATTEMPTS = 3;
const DELIVERY_SUBMIT_ATTEMPTS = 2; // initial Enter + one evidence-backed re-press (OBS-140)
const DELIVERY_VERIFY_TIMEOUT_MS = 2000; // per attempt — a paste that hasn't rendered in 2s is retyped
const DELIVERY_READ_LINES = 80;
const DELIVERY_SETTLE_READ_ATTEMPTS = 6;
const DELIVERY_SETTLE_POLL_MS = 100;
const DELIVERY_READINESS_TIMEOUT_MS = 1_000;
// OBS-140/253: a shell or bootstrap dispatch is acknowledged by a START nonce the delivered line
// PRINTS as its first statement. The printf splits the nonce across two arguments, so the joined
// marker exists only after the shell actually ran the line — a pane that merely echoed the text it
// was given never produces it. The marker is written to a private file as well as the pane, because
// a pane snapshot is not a channel: a full-screen TUI or a noisy launch can scroll a printed nonce
// out of any bounded read, and a successful dispatch read as corrupt is dispatched TWICE.
export const DISPATCH_START_PREFIX = "TICKMARKR_START_";
const DISPATCH_ACK_TIMEOUT_MS = 15_000;
const DISPATCH_ACK_POLL_MS = 100;

interface DeliveryReadinessEvidence {
  waitedMs: number;
  timeoutMs: number;
  transcript: string;
}

export interface HerdrTimeSource {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const SYSTEM_TIME: HerdrTimeSource = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// OBS-142: a typed identity lets the daemon's next task distinguish cold-start variance from
// structural driver faults without parsing prose. The message also carries the bounded wait and
// final pane evidence so a terminal failure is diagnosable on its own.
export class DeliveryReadinessError extends Error {
  readonly phase = "READINESS";

  constructor(
    readonly waitedMs: number,
    readonly transcript: string,
  ) {
    super(`herdr delivery READINESS failed after ${waitedMs}ms — interface never became interactive (OBS-142); pane transcript:\n${transcript}`);
    this.name = "DeliveryReadinessError";
  }
}

// OBS-253: the dispatch-corruption class, typed so the driver's own one-shot recovery can recognise
// it and the daemon can keep classifying an unrecovered one as `kind: dispatch`. A dispatch that
// never registered produced no output to trust, so a fresh-pane retry risks nothing a first dispatch
// does not already risk — the second consecutive one is what parks the task.
export class DeliveryCorruptedError extends Error {
  readonly phase = "DISPATCH";

  constructor(
    readonly pane: string,
    reason: string,
    readonly transcript: string,
  ) {
    super(`herdr delivery corrupted on pane ${pane} — ${reason} (OBS-140/253); pane transcript:\n${transcript}`);
    this.name = "DeliveryCorruptedError";
  }
}

export type DriverJournal = (event: string, slotName: string, data: Record<string, unknown>) => void;

/** First-generation join direction from measured trailer-safe floor (43-MEASUREMENT.md). */
export function workerSplitDirection(paneCols: number | null, safeFloor = TRAILER_SAFE_FLOOR_COLS, margin = TRAILER_WIDTH_MARGIN): "right" | "down" {
  if (paneCols == null || paneCols <= 0) return "down";
  return paneCols / 2 >= safeFloor + margin ? "right" : "down";
}

// VIS-04 role-tab + VIS-09 item 2 cap/overflow: live members of one ref-counted tab (a GENERATION);
// a group holds N generations (WORKERS, cleanup, cleanup, …), each its own tab, cap-bounded. Teardown
// is refcounted PER GENERATION: each overflow tab closes when its OWN last member leaves (43-02).
interface GroupEntry { tabId: string; label: string; members: { name: string; paneId: string }[] }

/** The tab a slot belongs to: its TASK — worker, judge, review and consult panes for one task share it.
 *  Returns undefined for everything else, which keeps those on the dedicated-tab path.
 *
 *  The ROLE gate is load-bearing and was added after it bit: `canonicalizeLegacyName` returns
 *  `role:"other", taskId:"<the whole name>"` for any unrecognised string, so keying on taskId alone
 *  makes EVERY one-off pane its own "task" and gives it a group tab. `watch` is excluded for the same
 *  reason in the other direction — its taskId is the literal "run", which is a board, not a task. */
const TASK_TAB_ROLES = new Set(["worker", "judge", "review", "consult"]);
export function taskGroupOf(name: string): string | undefined {
  const { role, taskId } = canonicalizeLegacyName(name, "");
  if (!TASK_TAB_ROLES.has(role)) return undefined;
  return taskId && taskId.trim() ? taskId : undefined;
}

/** Gate panes ride with the task they belong to and never consume the tab cap; everything else does.
 *  Scoped to the three GATE roles deliberately — an earlier cut of this said "not a worker", which let
 *  role:"other" members (any unrecognised name) bypass the cap and silently disabled overflow for
 *  explicit stage groups. The cap still governs every member it governed before. */
const GATE_ROLES = new Set(["judge", "review", "consult"]);
const ridesWithTask = (name: string): boolean => GATE_ROLES.has(canonicalizeLegacyName(name, "").role);
const cappedMembers = (g: GroupEntry): number => g.members.filter((m) => !ridesWithTask(m.name)).length;
// splitUnsupported is PER GROUP (a herdr that can't split can't split in any tab); `created` is a
// monotonic generation counter so distinct overflow generations never collide as objects (VIS-13:
// overflow labels are all "cleanup" — distinguished by their live member token, never a WORKERS-N).
interface GroupState { generations: GroupEntry[]; created: number; splitUnsupported?: boolean }
interface DispatchLease { release: () => void }
interface LifecycleInputBox extends InputBox { firstDeliveryIsLaunch?: true }

export class HerdrDriver implements ExecutorDriver {
  id = "herdr";
  interactive = true;

  private groups = new Map<string, GroupState>();
  // grouped slot()/close() mutate shared group state across awaits — serialize them so two
  // concurrent first members can never both create the group tab (mergeSerial idiom, daemon.ts)
  private groupSerial: Promise<unknown> = Promise.resolve();
  // OBS-120: canonical dispatch slots hold this chain from allocation through verified binding and
  // delivery. Legacy/manual slots still serialize each delivery on the same chain (OBS-119).
  private deliverySerial: Promise<unknown> = Promise.resolve();
  private dispatchLeases = new WeakMap<Slot, DispatchLease>();
  private deliveredPanes = new WeakMap<Slot, string>();
  private inputBoxes = new WeakMap<Slot, InputBox>();
  // OBS-253: the adapter-declared bootstrap this slot has already delivered. A fresh pane is a bare
  // shell, so it is the only thing that can put a TUI back under a typed turn that has to move.
  private bootstraps = new WeakMap<Slot, string>();
  // runDaemon gives the driver the authoritative repo root at its worktree seam before it allocates
  // that task's slot. Keep the binding by cwd so a dispatch retry opens THAT run's Journal even when
  // the caller launched tickmarkr elsewhere (process.cwd is not run identity). The repo itself is
  // also bound for judge/review/consult slots whose cwd is the root rather than a task worktree.
  private journalRoots = new Map<string, string>();

  // VIS-10: the run's workspace id, captured once at construction (the daemon inherits it from the
  // operator's env before the driver is built). Required at slot() time, never in the constructor —
  // pickDriver and its unit test construct HerdrDriver without env, so slot() is the trust gate.
  private ws = process.env.HERDR_WORKSPACE_ID;
  private callerPane = process.env.HERDR_PANE_ID;
  private watches = new Map<string, Slot>();

  constructor(
    private bin = "herdr",
    private workersPerTab = 3,
    private time: HerdrTimeSource = SYSTEM_TIME,
    private journal?: DriverJournal,
  ) {}

  // The dispatch-retry record is mandatory: it is the only durable fact left by a recovered pane
  // swap. Tests may inject a sink, while production resolves the daemon's real Journal from the
  // worktree binding plus the canonical slot name. Every resolution/open/append failure propagates;
  // an unjournaled recovery is never performed and its audit failure is never hidden by the original
  // corruption error.
  private appendDispatchRetry(slot: Slot, data: Record<string, unknown>): void {
    if (this.journal) {
      this.journal("dispatch-retry", slot.name, data);
      return;
    }
    const owned = parseOwnedName(slot.name);
    if (!owned) throw new Error(`cannot journal dispatch-retry: slot ${slot.name} carries no run identity`);
    const repoRoot = this.journalRoots.get(slot.cwd);
    if (!repoRoot) {
      throw new Error(`cannot journal dispatch-retry: slot ${slot.name} has no daemon repo binding for ${slot.cwd}`);
    }
    Journal.open(repoRoot, owned.runId).append("dispatch-retry", owned.taskId, data);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.groupSerial.then(fn, fn);
    this.groupSerial = p.catch(() => undefined);
    return p;
  }

  private deliveryQueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.deliverySerial.then(fn, fn);
    this.deliverySerial = p.catch(() => undefined);
    return p;
  }

  // OBS-120: ExecutorDriver exposes slot() and run() separately, so a canonical tickmarkr slot
  // carries a lease across that API seam. The next dispatch cannot allocate until this slot's first
  // run either delivers or fails. Allocation errors release immediately; no failed dispatch poisons
  // the queue. The daemon calls run() directly after preparing the command for every owned slot.
  private reserveDispatch(allocate: () => Promise<Slot>): Promise<Slot> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const start = this.deliverySerial.then(() => undefined, () => undefined);
    this.deliverySerial = start.then(() => held);
    return start.then(async () => {
      let slot: Slot | undefined;
      try {
        slot = await allocate();
        this.dispatchLeases.set(slot, { release });
        return slot;
      } catch (error) {
        if (slot) {
          try { await this.close(slot); } catch { /* allocation already failed closed; cleanup is best-effort */ }
        }
        release();
        throw error;
      }
    });
  }

  private async verifyPaneIdentityBinding(slot: Slot): Promise<string> {
    const paneId = await this.namedPaneId(slot.name);
    if (paneId !== slot.id) {
      throw new Error(
        `herdr pane identity binding verification failed for ${slot.name}: allocated ${slot.id}, resolved ${paneId ?? "none"} — refusing delivery`,
      );
    }
    return paneId;
  }

  // ponytail: narrow panes hard-wrap the input line — collapse whitespace before comparing.
  private deliveryMatches(transcript: string, cmd: string): boolean {
    // OBS-154: a TUI editor re-wraps a long delivery across its own bordered rows, so the pane text
    // carries `│` between fragments we typed as ONE line. Stripping whitespace alone left the needle
    // uncontainable, so the read-back could not recognize its own SUCCESSFUL delivery and the OBS-85
    // guard then refused to retype onto what it had been told was corruption (probe 6b).
    // This is the opposite question to shellExecutionEchoed, which deliberately REJECTS box rows: a
    // shell echo must come from a shell prompt, whereas here we only ask whether our text landed —
    // and inside the editor box is exactly where it is supposed to land.
    const norm = (s: string) => s.replace(/[│┃|]/g, "").replace(/\s+/g, "");
    const hay = norm(transcript);
    const needle = norm(cmd);
    return needle.length > 0 && hay.includes(needle);
  }

  // v1.85 T5: submission is acknowledged CAUSALLY or not at all. The adapter's declared OCCUPIED
  // state means the prompt is still sitting in the box — never submitted; its declared EMPTY state
  // means the box consumed it. Nothing else counts: the positional-transcript fallback this used to
  // end with (prompt found, bytes exist after it ⇒ "delivered") answered yes for panes that had
  // processed nothing (OBS-181), and it is DELETED. A box that is off-screen or unrecognisable is an
  // absence of evidence, which fails closed — the same posture every gate takes. The launch-stage
  // shell-echo reader is gone with it: a bootstrap line is now delivered atomically and acknowledged
  // by its own START nonce, so there is no echo left to read (OBS-144 closed by construction).
  private submissionRegistered(transcript: string, inputBox: InputBox): boolean {
    if (matchesOccupiedInputBox(transcript, inputBox)) return false;
    return matchesEmptyInputBox(transcript, inputBox);
  }

  static available(): boolean {
    return process.env.HERDR_ENV === "1";
  }

  private herdr(args: string, cwd = process.cwd(), timeoutMs?: number) {
    return sh(`${shq(this.bin)} ${args}`, cwd, timeoutMs);
  }

  // herdr 0.7.5 (OBS-123): an "agent" is a DETECTED agent-CLI, so `agent get <name>` no longer resolves
  // a tickmarkr-named bash pane. Durable identity is the pane LABEL (set via `pane rename`); resolve it
  // by reading the label back from `pane list`.
  private async namedPaneId(name: string): Promise<string | null> {
    const r = await this.herdr(`pane list`);
    if (r.code !== 0) return null;
    try {
      const panes = JSON.parse(r.stdout).result?.panes;
      if (!Array.isArray(panes)) return null;
      const hit = panes.find((p: { label?: string; pane_id?: string }) => p.label === name && typeof p.pane_id === "string" && p.pane_id);
      return hit?.pane_id ?? null;
    } catch {
      return null;
    }
  }

  // Before delivery, resolve fresh via the durable name because pane ids can compact. After delivery,
  // pin the verified target so early liveness cannot drift to a label rebound onto another pane.
  private async paneId(slot: Slot): Promise<string> {
    const delivered = this.deliveredPanes.get(slot);
    if (delivered) return delivered;
    return await this.namedPaneId(slot.name) ?? slot.id;
  }

  // VIS-09 P43-03: runtime width for the layout gate (43-MEASUREMENT.md licensing condition 2).
  private async paneWidth(paneId: string): Promise<number | null> {
    const r = await this.herdr(`pane layout --pane ${shq(paneId)}`);
    if (r.code !== 0) return null;
    try {
      const layout = JSON.parse(r.stdout).result?.layout;
      const pane = layout?.panes?.find((p: { pane_id?: string }) => p.pane_id === paneId);
      const w = pane?.rect?.width ?? layout?.area?.width;
      return typeof w === "number" && w > 0 ? w : null;
    } catch {
      return null;
    }
  }

  async slot(cwd: string, name: string, opts?: SlotOpts): Promise<Slot> {
    const inputBox = declaredInputBoxForWorkerName(name);
    // T1 ownership contract: `opts.owned` (T2 call sites) names the pane canonically —
    // tickmarkr:<role>:<taskId>:<attempt>:<runId>. Without it, `name` passes through byte-identical
    // (today's legacy daemon/gates/consult shapes) — canonicalizeLegacyName (types.ts) is what lets
    // reconcile.ts and this driver's own renameGroupTab/glyphFor decode role/taskId/attempt from
    // those shapes without a call-site migration; T2 retires this branch by always passing `owned`.
    const resolved = opts?.owned ? formatOwnedName(opts.owned) : name;
    // ONE TAB PER TASK. The group defaults to the task id, derived from the same parser that already
    // decodes role/taskId for tab labels — so a worker and every gate pane it earns (judge, review,
    // consult) land in that task's tab instead of scattering. Deriving it HERE rather than at each
    // call site is the point: the defect this replaces was three call sites of which exactly one
    // passed a group, so judge/review/consult each opened a tab of their own. A caller may still pass
    // `group` explicitly to override, and a name with no task id (or an explicit `label`) keeps the
    // dedicated-tab path unchanged.
    // PRECEDENCE: a task-bearing name ALWAYS groups by its task; an explicit `group` applies only to
    // names with no task identity. That direction is deliberate — the invariant is "a task's panes are
    // never scattered", and a caller passing a stage group (the daemon still passes "workers", which now
    // serves as the fallback for task-less names) must not be able to override it by omission or habit.
    // An explicit `label` still wins outright: that is the dedicated-role-tab path, chosen on purpose.
    const derivedGroup = opts?.label ? undefined : taskGroupOf(resolved);
    const group = derivedGroup ?? opts?.group;
    const allocate = group
      ? () => this.serial(() => this.groupSlot(cwd, resolved, group))
      : () => this.tabSlot(cwd, resolved, opts?.label);
    // Production dispatch names are canonical even when the gate call site supplies the already-
    // formatted name rather than SlotOpts.owned. Hold one lease across slot() → run(); legacy/manual
    // slots retain their existing allocation-only semantics for compatibility.
    const slot = parseOwnedName(resolved) ? await this.reserveDispatch(allocate) : await allocate();
    if (inputBox) this.inputBoxes.set(slot, inputBox);
    // group wins if both are set (a group tab is already stage-labeled; passing both is a caller bug).
    // label (without group) → dedicated labeled tab via tabSlot's third param: no groups-map entry, no
    // refcount, no groupSerial, no degrade latch — dedicated tabs have no shared state to guard (SUP-01).
    return slot; // label undefined → defaults to name (today's behavior)
  }

  // today's per-slot tab path, plus the VIS-04 orphan reap
  // label defaults to the slot name; group tabs pass the STAGE name instead — a first-member label
  // outlives its member once keepPanes reaps it (run-20260709-104447: the codex pane sat in a tab
  // named after a dead cursor worker and the operator read it as a mislabeled agent)
  private async tabSlot(cwd: string, name: string, label: string = name): Promise<Slot> {
    // tab-per-slot: concurrent agents in one tab split it into sliver columns — TUIs exit or
    // hard-wrap at COLUMNS≈2, shredding even the TICKMARKR_RESULT marker (v1.4 phase-1 incident).
    // A dedicated named tab gives every agent a full-width pane; tab close() reaps it.
    // VIS-10 (operator ruling 2026-07-11): "pane placed by focus heuristic" is a DEFECT CLASS.
    // Fail closed at every step — env unset, tab-create non-zero, unparseable stdout, or a parsed
    // payload with no tab_id all REJECT. There is no path from here to an untargeted pane.
    if (!this.ws) throw new Error("herdr placement requires HERDR_WORKSPACE_ID — refusing untargeted pane (VIS-10: fail closed, never place by focus)");
    // pin the tab to the RUN's workspace, UNCONDITIONALLY (inherited via HERDR_WORKSPACE_ID), never the
    // operator's focused one (Intl-Dossier run-20260709-104447 incident: worker tabs opened in the tickmarkr repo workspace)
    // herdr 0.7.5 (OBS-123): `tab create --cwd` spawns the tab's root shell pane already at a prompt in
    // the worktree — that root pane IS the worker pane. The old one-shot `agent start … -- bash` verb
    // (which named a fresh bash pane) was removed; 0.7.5's `agent start` only ATTACHES to a DETECTED
    // agent CLI, so tickmarkr names the bash pane itself via `pane rename` and types the worker command in.
    const t = await this.herdr(`tab create --label ${shq(label)} --no-focus --workspace ${shq(this.ws)} --cwd ${shq(cwd)}`);
    if (t.code !== 0) throw new Error(`herdr tab create failed (exit ${t.code}, refusing untargeted placement): ${t.stderr || t.stdout}`);
    let res: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } };
    try {
      res = JSON.parse(t.stdout).result;
    } catch {
      throw new Error(`herdr tab create returned unparseable JSON (refusing untargeted placement): ${t.stdout}`);
    }
    const tabId = res?.tab?.tab_id;
    const id = res?.root_pane?.pane_id; // the tab's root shell pane, already in cwd — this run's worker pane
    if (typeof tabId !== "string" || !tabId) throw new Error(`herdr tab create returned no tab_id (refusing untargeted placement): ${t.stdout}`);
    if (typeof id !== "string" || !id) throw new Error(`herdr tab create returned no root pane id (refusing untargeted placement): ${t.stdout}`);
    // durable identity: label the PANE (resolution + reconcile read it back via `pane list`); fail closed
    // and reap the tab we just made if the rename fails (no orphan tab).
    const rn = await this.herdr(`pane rename ${shq(id)} ${shq(name)}`);
    if (rn.code !== 0) {
      await this.herdr(`tab close ${shq(tabId)}`);
      throw new Error(`herdr pane rename failed: ${rn.stderr || rn.stdout}`);
    }
    // DEFECT-01: a prior (killed) process's kept pane may still carry this durable label (resume +
    // keepPanes re-dispatches at attempt=0 into the same name). 0.7.5 rename never collides, so instead
    // of agent_name_taken we sweep stale same-label panes and verify this fresh pane is the sole holder.
    await this.reclaimStaleLabel(name, id);
    // VIS-10 hole 3: seed the run's workspace id into the agent pane's shell so a worker's own ad-hoc
    // `herdr` call is workspace-targeted BY CONSTRUCTION — correct placement is the default a worker GETS,
    // not a rule it must remember (P40-02 probe leak). Fail closed: a failed seed rejects.
    // v1.22 T3 / OBS-17: also strip HERDR_ENV + socket path so the worker cannot open/mutate panes in
    // the operator's session. Daemon-side this.herdr() calls keep process.env (unsealed).
    const seed = await this.herdr(
      `pane run ${shq(id)} ${shq(`export HERDR_WORKSPACE_ID=${shq(this.ws)}; export ${PANE_IDENTITY_ENV}=${shq(paneIdentityLine(canonicalizeLegacyName(name, "")))}; ${herdrSealShellPrefix()}`)}`,
    );
    if (seed.code !== 0) throw new Error(`herdr workspace-id seed failed (refusing untargeted pane): ${seed.stderr || seed.stdout}`);
    return { id, name, cwd, tabId };
  }

  // DEFECT-01 (0.7.5): close any OTHER pane still carrying this durable label (a prior killed attempt's
  // kept pane), then verify none remain — else fail closed, since `pane list` would otherwise resolve the
  // name to an ambiguous/stale pane. No-op on the common path (no dup labels). Best-effort closes; the
  // post-sweep re-list is the fail-closed gate (a close that does not free the name must reject).
  private async reclaimStaleLabel(name: string, fresh: string): Promise<void> {
    const stale = await this.staleLabelPanes(name, fresh);
    if (stale.length === 0) return;
    for (const p of stale) await this.herdr(`pane close ${shq(p)}`);
    if ((await this.staleLabelPanes(name, fresh)).length > 0) {
      throw new Error(`herdr pane rename reclaim failed — durable name ${name} still held by a stale pane`);
    }
  }

  private async staleLabelPanes(name: string, fresh: string): Promise<string[]> {
    const r = await this.herdr(`pane list`);
    try {
      const panes = JSON.parse(r.stdout).result?.panes ?? [];
      return panes
        .filter((p: { label?: string; pane_id?: string }) => p.label === name && typeof p.pane_id === "string" && p.pane_id !== fresh)
        .map((p: { pane_id: string }) => p.pane_id);
    } catch {
      return [];
    }
  }

  // VIS-04 role-tab (extended VIS-09 item 2): first member bootstraps generation 1 (WORKERS);
  // later members join the latest generation with live-member room via joinGroup, else a NEW
  // overflow generation tab (cleanup, cleanup, …) opens — a second `tab create`, NOT a further
  // split of tab 1. The cap is the constructor's workersPerTab (plumbed from config via pickDriver).
  // splitUnsupported stays PER GROUP: a herdr that can't split can't split in any tab, so once it
  // latches every later member degrades to a per-slot tab (no overflow tab can be populated by join).
  private async groupSlot(cwd: string, name: string, group: string): Promise<Slot> {
    const state = this.groups.get(group);
    if (state?.splitUnsupported) return this.tabSlot(cwd, name); // D-09: degrade, NOT a shared-tab member
    if (state) {
      const latest = state.generations[state.generations.length - 1];
      // A task tab's judge/review/consult panes belong with their worker and must never overflow into a
      // `cleanup` tab — that would re-scatter exactly what the per-task grouping exists to gather. They
      // therefore join freely and do not consume `workersPerTab`; every other member still does.
      if (latest && (ridesWithTask(name) || cappedMembers(latest) < this.workersPerTab)) {
        const joined = await this.joinGroup(cwd, name, group, latest);
        if (joined) return joined;
        state.splitUnsupported = true; // D-09 fail-safe: this and future members degrade to per-slot tabs
        return this.tabSlot(cwd, name);
      }
      return this.newGeneration(cwd, name, group, state); // cap full → overflow to a new generation tab
    }
    const fresh: GroupState = { generations: [], created: 0 };
    this.groups.set(group, fresh);
    return this.newGeneration(cwd, name, group, fresh); // first member ever → bootstrap generation 1
  }

  // bootstrap a fresh generation tab: gen 1 keeps the WORKERS stage label (today's primary tab);
  // every overflow generation is a "cleanup" tab (VIS-13 amendment) — never a WORKERS-N numeric suffix.
  private async newGeneration(cwd: string, name: string, group: string, state: GroupState): Promise<Slot> {
    state.created++;
    const label = state.created === 1 ? group.toUpperCase() : "cleanup";
    const s = await this.tabSlot(cwd, name, label);
    const entry = { tabId: s.tabId!, label, members: [{ name, paneId: s.id }] };
    state.generations.push(entry);
    await this.renameGroupTab(entry);
    return { ...s, group };
  }

  // Only GroupEntry instances originate in newGeneration(), after tabSlot created the tab. This never
  // adopts or renames an operator tab; the newest live worker contributes at most one task-id token.
  // VIS-13: that token carries ONE state glyph — ↻ for a retry attempt (attempt > 0 parsed from the
  // member name), ✋ when the driver observes the member blocked (queried live); bare on normal running.
  // T1: token/attempt now come from canonicalizeLegacyName (types.ts) instead of ad hoc regex — same
  // extraction for today's legacy names ("T2-worker-...-a0-...") and, once T2 passes `owned`, for
  // canonical names too — one parser, not two.
  private async renameGroupTab(entry: GroupEntry): Promise<void> {
    const newest = [...entry.members].reverse().find((m) => canonicalizeLegacyName(m.name, "").role === "worker");
    const token = newest ? canonicalizeLegacyName(newest.name, "").taskId : undefined;
    const glyph = newest ? await this.glyphFor(newest) : "";
    // A per-task tab is already labelled with its task id; appending the same token again reads as a
    // duplicate rather than as state, so the glyph rides the existing label instead.
    const label = !token ? entry.label
      : entry.label === token ? `${token}${glyph}`
      : `${entry.label} · ${token}${glyph}`;
    const cmd = `tab rename ${shq(entry.tabId)} ${shq(label)}`;
    const ok = async () => (await this.herdr(cmd)).code === 0;
    if (await ok() || await ok()) return;
    try {
      await this.notify(`tickmarkr tab relabel failed: ${entry.tabId} → ${label}`);
    } catch {
      /* OBS-45: cosmetic only — a relabel failure never blocks membership or teardown (v1.18 invariant) */
    }
  }

  // VIS-13: at most one glyph on the hot token. ✋ wins — the driver observes the member blocked live
  // (the actionable state the operator must clear); else ↻ for a retry attempt (attempt > 0 in the
  // member's owned name); else bare. Status observation failure → "unknown" (never ✋), fail-safe.
  private async glyphFor(m: { name: string }): Promise<string> {
    if ((await this.statusByName(m.name)) === "blocked") return "✋";
    return canonicalizeLegacyName(m.name, "").attempt > 0 ? "↻" : "";
  }

  // stack a subsequent member into the group tab; null → caller degrades (D-09)
  private async joinGroup(cwd: string, name: string, group: string, entry: GroupEntry): Promise<Slot | null> {
    // pane ids compact when panes close — resolve the split source fresh from the newest LIVE
    // member's durable name (never a cached id: closing the newest member must not poison this)
    const src = entry.members[entry.members.length - 1];
    const srcPane = await this.paneId({ id: src.paneId, name: src.name, cwd });
    // VIS-09 P43-03 (43-MEASUREMENT.md): first join in a generation may split right when
    // paneWidth/2 ≥ TRAILER_SAFE_FLOOR_COLS + margin (measured floor 108, margin 2); later joins
    // stack down. Rightward splits below the measured floor shred the marker (e8aa003 at COLUMNS≈2;
    // unrecoverable at 25 cols per measurement). Introspection failure → down (fail closed).
    const direction = entry.members.length === 1 ? workerSplitDirection(await this.paneWidth(srcPane)) : "down";
    const sp = await this.herdr(`pane split ${shq(srcPane)} --direction ${direction} --no-focus --cwd ${shq(cwd)}`);
    if (sp.code !== 0) return null;
    let pane: string | undefined;
    try {
      pane = JSON.parse(sp.stdout).result?.pane?.pane_id ?? undefined;
    } catch {
      /* fall through to degrade */
    }
    if (typeof pane !== "string" || !pane) return null;
    // the split pane is a bare shell: give it a durable PANE label (0.7.5 — agent rename only binds
    // detected agents; SKILL:197 was the old agent-name path) and VERIFY the label resolves back to this
    // pane (research A1 is checked live per join, never assumed). `pane split --cwd` already placed the
    // shell in this member's worktree, so no separate `cd` is needed.
    const rn = await this.herdr(`pane rename ${shq(pane)} ${shq(name)}`);
    const verified = rn.code === 0 && (await this.paneId({ id: "", name, cwd })) === pane;
    if (!verified) {
      await this.herdr(`pane close ${shq(pane)}`); // reap the failed join, best-effort
      return null;
    }
    // VIS-10 hole 3: seed the run's workspace id into the split pane's shell. A split pane is a bare
    // shell with FRESH env from herdr (not the parent pane's exports), so without this a worker's
    // ad-hoc herdr call from this pane would be untargeted. Fail closed: a failed seed reaps + degrades
    // like a failed cd (return null → caller falls back to a per-slot tab). this.ws is guaranteed set —
    // joinGroup runs only after the first member's tabSlot succeeded, which requires it (VIS-10).
    // v1.22 T3: same env seal as tabSlot — strip control-plane vars after the workspace seed.
    // T5: same brand identity seed as tabSlot — every group member's banner announces its own name.
    const seed = await this.herdr(
      `pane run ${shq(pane)} ${shq(`export HERDR_WORKSPACE_ID=${shq(this.ws!)}; export ${PANE_IDENTITY_ENV}=${shq(paneIdentityLine(canonicalizeLegacyName(name, "")))}; ${herdrSealShellPrefix()}`)}`,
    );
    if (seed.code !== 0) {
      await this.herdr(`pane close ${shq(pane)}`);
      return null;
    }
    entry.members = [...entry.members, { name, paneId: pane }];
    await this.renameGroupTab(entry);
    return { id: pane, name, cwd, tabId: entry.tabId, group };
  }

  // v1.85 T5 (OBS-140/253): every dispatch is routed by what the target actually IS. A shell or
  // bootstrap line goes out atomically through `pane run` and is acknowledged by its own START
  // nonce; only a real TUI turn — an adapter-declared input box, and not that adapter's own launch
  // command — earns the typed pincer. One dispatch corruption is then retried in-process against a
  // FRESH pane before anything is reported as a failure.
  async run(slot: Slot, cmd: string): Promise<void> {
    // paneLaunchCommand is a linear same-call handoff: consume before the first await so concurrent
    // task dispatches cannot exchange intent. The command remains an ordinary string for every
    // ExecutorDriver implementation; classification never reads its bytes when the builder spoke.
    const recordedLaunch = consumePaneLaunchIntent();
    const lease = this.dispatchLeases.get(slot);
    if (lease) {
      this.dispatchLeases.delete(slot);
      try {
        const paneId = await this.verifyPaneIdentityBinding(slot);
        await this.dispatchWithRetry(slot, cmd, paneId, recordedLaunch);
      } finally {
        lease.release();
      }
      return;
    }
    return this.deliveryQueue(async () => {
      await this.dispatchWithRetry(slot, cmd, await this.paneId(slot), recordedLaunch);
    });
  }

  // OBS-253: dispatch corruption is self-clearing — all ten recorded occurrences cleared on a fresh
  // pane and a fresh submit, and every one of them cost an operator `resume --retry-failed`. Retry
  // ONCE here against a pane that has never seen this delivery; the wedged pane is closed, never
  // re-pressed. A second consecutive corruption propagates, and the daemon parks the task on it.
  private async dispatchWithRetry(slot: Slot, cmd: string, pane: string, recordedLaunch = false): Promise<void> {
    try {
      await this.dispatch(slot, cmd, pane, recordedLaunch);
      this.deliveredPanes.set(slot, pane);
      return;
    } catch (error) {
      if (!(error instanceof DeliveryCorruptedError)) throw error;
      // A fresh pane is a bare shell. A shell dispatch is simply re-run on it; a typed turn first
      // needs its interface back, which is possible only where the adapter declared the bootstrap
      // this slot already delivered. Retyping a turn into a bare shell would guarantee the second
      // failure rather than recover from the first, so without a replayable bootstrap the
      // corruption propagates untouched.
      const typedTurn = this.isTuiTurn(slot, cmd, recordedLaunch);
      const relaunch = typedTurn ? this.bootstraps.get(slot) : undefined;
      if (typedTurn && relaunch === undefined) throw error;
      // Record BEFORE acting: a retry that cannot be written to the run's ledger is not taken at all,
      // because an unrecorded pane swap is exactly the silence OBS-253 cost ten times. The journal
      // failure itself propagates visibly; the original corruption then remains terminal rather than
      // triggering an off-record recovery.
      this.appendDispatchRetry(slot, { wedgedPane: pane, reason: error.message });
      const fresh = await this.freshPane(slot, pane);
      if (fresh === null) throw error;
      if (relaunch !== undefined) await this.deliverAtomic(slot, relaunch, fresh);
      await this.dispatch(slot, cmd, fresh, recordedLaunch);
      this.deliveredPanes.set(slot, fresh);
    }
  }

  // Is this delivery a turn TYPED into a running interface, rather than a line a shell runs? The
  // The builder's recorded fact decides first, regardless of command bytes. For direct driver users,
  // an adapter may declare the fresh-slot lifecycle rather than a prefix list. Legacy declarations
  // still decide where neither stronger fact exists. With NO declaration the only evidence is history — a
  // pane that already accepted a delivery is running whatever that delivery started, so a second
  // delivery is a turn into it. Answering "shell" there is what would run an adapter's seed prompt
  // as a shell command; answering "turn" routes it to deliverTyped, which refuses it by name
  // because the adapter declared no input box (fail closed, never a guess).
  private isTuiTurn(slot: Slot, cmd: string, recordedLaunch = false): boolean {
    if (recordedLaunch) return false;
    const inputBox = this.inputBoxes.get(slot) as LifecycleInputBox | undefined;
    if (inputBox?.firstDeliveryIsLaunch && !this.deliveredPanes.has(slot)) return false;
    return inputBox ? inputBox.launchCommand?.(cmd) !== true : this.deliveredPanes.has(slot);
  }

  private dispatch(slot: Slot, cmd: string, pane: string, recordedLaunch = false): Promise<void> {
    if (this.isTuiTurn(slot, cmd, recordedLaunch)) return this.deliverTyped(slot, cmd, pane);
    // A classified bootstrap is the one command that can restore this slot's interface on a fresh
    // pane, so remember the fact's command without asking its bytes to prove the classification again.
    if (this.inputBoxes.has(slot)) this.bootstraps.set(slot, cmd);
    return this.deliverAtomic(slot, cmd, pane);
  }

  // The OBS-140 class dies here. `pane run` puts text and Enter in ONE herdr request, so there is no
  // seam in which a swallowed Enter can leave a verified-but-unsubmitted prompt, and nothing about
  // the delivery is inferred from typed-text read-back. The line's first two statements print a
  // per-dispatch START nonce assembled from two printf arguments — once to a file whose name only
  // this process knows, then once to the pane for the operator. The joined marker cannot exist
  // unless the shell RAN our line, so the acknowledgment is causal; and because the file is written
  // before the agent the line launches produces a byte, no amount of later output can hide it. Both
  // statements are shell builtins: the ack cannot fail for want of a binary on the pane's PATH.
  //
  // v1.85 T5 review: the durable half GATES the launch, and goes FIRST. A dispatch whose ack the
  // pane could not write is indistinguishable, from here, from a line that never ran — so if the
  // command ran anyway, the miss buys a fresh pane and a SECOND live agent for the same task. The
  // `|| exit 1` makes that impossible: no ack, no command. Ordering carries the same weight in the
  // other direction — a pane-visible marker printed before a failed ack write would satisfy the
  // event watch and report a launch that never happened.
  private async deliverAtomic(slot: Slot, cmd: string, pane: string): Promise<void> {
    const suffix = randomUUID(); // unguessable: nothing the delivered command runs can forge the ack
    const nonce = `${DISPATCH_START_PREFIX}${suffix}`;
    const ackPath = join(tmpdir(), `tickmarkr-dispatch-${suffix}.ack`);
    // Open the channel before spending a pane on it: an ack path this process cannot write is a
    // broken host, not a wedged pane, and the fresh-pane retry would fail there for the same reason.
    // Throwing something other than DeliveryCorruptedError is what keeps that retry unspent.
    try {
      writeFileSync(ackPath, ""); // empty: only the delivered line may ever put the nonce here
    } catch (error) {
      throw new Error(`dispatch acknowledgment channel unavailable (${ackPath}): ${(error as Error).message}`);
    }
    const marker = `printf '%s%s\\n' ${shq(DISPATCH_START_PREFIX)} ${shq(suffix)}`;
    const line = `${marker} > ${shq(ackPath)} || exit 1; ${marker}; ${cmd}`;
    const deadline = this.time.now() + DISPATCH_ACK_TIMEOUT_MS;
    try {
      const sent = await this.herdr(`pane run ${shq(pane)} ${shq(line)}`, slot.cwd);
      if (sent.code !== 0) {
        throw new DeliveryCorruptedError(pane, `pane run failed: ${sent.stderr || sent.stdout}`, "");
      }
      // Fast path: herdr's own event-driven watch on the pane's output. A match is causal — the pane
      // cannot emit the joined marker without having RUN the line. A MISS is not evidence of
      // anything: this watch subscribes after the request, and a full-screen repaint can swallow the
      // very line it is watching for, which is how a successful launch got dispatched twice. So a
      // miss falls through to the channel the line wrote for itself, which nothing can repaint.
      const seen = await this.herdr(
        `pane wait-output ${shq(pane)} --match ${shq(nonce)} --timeout ${DISPATCH_ACK_TIMEOUT_MS}`,
        slot.cwd,
        DISPATCH_ACK_TIMEOUT_MS + 15_000,
      );
      if (this.waitOk(seen.code, seen.stdout)) return;
      if (await this.awaitDispatchAck(ackPath, nonce, deadline)) return;
      // Only now, and only as evidence for the operator: the transcript explains the failure, it
      // never decides one. A pane that looks like it ran the line but never wrote the ack did not.
      const transcript = (await this.herdr(`pane read ${shq(pane)} --source recent-unwrapped --lines ${DELIVERY_READ_LINES}`, slot.cwd)).stdout;
      throw new DeliveryCorruptedError(pane, `START nonce ${nonce} never appeared — the line never ran`, transcript);
    } finally {
      try { unlinkSync(ackPath); } catch { /* never written, or already reaped — nothing to clean */ }
    }
  }

  // The durable half of the acknowledgment: the file the delivered line wrote before it launched
  // anything. Checked at least once even when the shared dispatch deadline has already passed, so a
  // watch that spent the whole window missing the line still gets the truth from the line itself.
  private async awaitDispatchAck(ackPath: string, nonce: string, deadline: number): Promise<boolean> {
    for (;;) {
      try {
        if (readFileSync(ackPath, "utf8").includes(nonce)) return true;
      } catch {
        /* the line has not reached the marker yet — or never will, which the deadline decides */
      }
      if (this.time.now() >= deadline) return false;
      await this.time.sleep(DISPATCH_ACK_POLL_MS);
    }
  }

  // OBS-253: a fresh pane is a SIBLING inside this slot's own tab. Split first so the tab can never
  // empty, then close the wedged pane and take its durable label — every other driver call addresses
  // this slot through that label or the delivered-pane pin, so no caller observes the swap.
  private async freshPane(slot: Slot, wedged: string): Promise<string | null> {
    if (!this.ws) return null;
    const sp = await this.herdr(`pane split ${shq(wedged)} --direction down --no-focus --cwd ${shq(slot.cwd)}`);
    if (sp.code !== 0) return null;
    let pane: string | undefined;
    try {
      pane = JSON.parse(sp.stdout).result?.pane?.pane_id ?? undefined;
    } catch {
      return null;
    }
    if (typeof pane !== "string" || !pane) return null;
    // The wedged pane is never re-pressed, only reaped — and the reap is a POSTCONDITION, not a
    // best-effort. It still carries this slot's durable label, so a close that fails (or succeeds
    // and frees nothing) leaves two panes answering to one name and `pane list` resolving it by
    // whichever comes first. Verify the name is free BEFORE the replacement is renamed, seeded or
    // dispatched: a fresh pane that is only PROBABLY the slot is not a fresh pane (v1.85 T5 review).
    const closed = await this.herdr(`pane close ${shq(wedged)}`);
    if (closed.code !== 0 || (await this.staleLabelPanes(slot.name, pane)).length > 0) {
      await this.herdr(`pane close ${shq(pane)}`);
      return null;
    }
    const rn = await this.herdr(`pane rename ${shq(pane)} ${shq(slot.name)}`);
    if (rn.code !== 0 || (await this.namedPaneId(slot.name)) !== pane) {
      await this.herdr(`pane close ${shq(pane)}`);
      return null;
    }
    // VIS-10 hole 3: a split pane is a bare shell with FRESH env, so it is untargeted until seeded.
    const seed = await this.herdr(
      `pane run ${shq(pane)} ${shq(`export HERDR_WORKSPACE_ID=${shq(this.ws)}; export ${PANE_IDENTITY_ENV}=${shq(paneIdentityLine(canonicalizeLegacyName(slot.name, "")))}; ${herdrSealShellPrefix()}`)}`,
      slot.cwd,
    );
    if (seed.code !== 0) {
      await this.herdr(`pane close ${shq(pane)}`);
      return null;
    }
    return pane;
  }

  // OBS-85 typed delivery, now reserved for real TUI turns: type WITHOUT enter, read the pane back
  // — `wait output --match` checks the same unwrapped transcript pane read exposes, event-driven so
  // wrap and render timing can't race the check — and press Enter only when that read-back contains
  // the typed command. A corrupted paste is captured (pane read), cleared (C-u), and retyped,
  // bounded; persistent corruption fails closed WITH the captured transcript.
  private async deliverTyped(slot: Slot, cmd: string, pane: string): Promise<void> {
    const inputBox = this.inputBoxes.get(slot);
    const missing = missingInputStateDeclarations(inputBox);
    if (missing.length > 0) {
      throw new Error(
        `herdr refuses typed delivery to ${slot.name}: the adapter has not declared its input states `
          + `(missing: ${missing.join(", ")}) — only a declared box can acknowledge a submission, and `
          + `nothing else may stand in for it (OBS-140)`,
      );
    }
    const readiness = await this.awaitDeliveryReadiness(slot, cmd, pane, inputBox!);
    let transcript = "";
    for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // A TUI may still be painting while the failed delivery is captured (OBS-135). Judge the
        // line only after two consecutive pane reads agree; an already-stable frame returns on the
        // first fresh read without a timer. A changing pane is bounded and preserves OBS-85's
        // fail-closed error instead of guessing from an adapter fingerprint.
        const settled = await this.settleDeliveryLine(pane, slot.cwd, transcript, inputBox);
        transcript = settled.transcript;
        if (!settled.ok) {
          throw new Error(`herdr delivery clear failed — refusing to retype onto a corrupted line (OBS-85); pane transcript:\n${transcript}`);
        }
        if (!settled.recognizedInputBox) {
          // Clear the corrupted shell input line before retyping; a failed clear must NOT be retyped
          // onto — corrupt-prefix + clean-retype would concatenate and false-verify by containment.
          // A stable adapter-declared input box is already an empty legitimate delivery target.
          const cleared = await this.herdr(`pane send-keys ${shq(pane)} C-u`, slot.cwd);
          if (cleared.code !== 0) throw new Error(`herdr delivery clear failed — refusing to retype onto a corrupted line (OBS-85); pane transcript:\n${transcript}`);
        }
      }
      const typed = await this.herdr(`pane send-text ${shq(pane)} ${shq(cmd)}`, slot.cwd);
      if (typed.code !== 0) throw new Error(`herdr pane send-text failed: ${typed.stderr || typed.stdout}`);
      const back = await this.herdr(
        `pane wait-output ${shq(pane)} --match ${shq(cmd)} --timeout ${DELIVERY_VERIFY_TIMEOUT_MS}`,
        slot.cwd,
        DELIVERY_VERIFY_TIMEOUT_MS + 15_000,
      );
      if (this.waitOk(back.code, back.stdout) || await this.deliveryReadMatches(pane, cmd, slot.cwd)) {
        await this.submitVerifiedDelivery(slot, pane, inputBox!, readiness);
        return;
      }
      // capture the corrupted delivery BEFORE clearing it — the OBS-85 byte-level evidence
      transcript = (await this.herdr(`pane read ${shq(pane)} --source recent-unwrapped --lines ${DELIVERY_READ_LINES}`, slot.cwd)).stdout;
    }
    throw new DeliveryCorruptedError(pane, `${DELIVERY_ATTEMPTS} typed attempts — enter never pressed (OBS-85)`, transcript);
  }

  // OBS-201: liveness nudge — deliver one message into the live worker TUI through the exact
  // pincer every dispatch uses (readiness stable-frame, type-without-Enter, read-back, C-u clear
  // on corruption, verified submit), serialized on the deliveryQueue so it can never interleave
  // with a concurrent dispatch's paste. Targets ONLY the pinned delivered pane: the pin exists so
  // liveness cannot drift to a label rebound onto another pane (herdr.ts paneId contract) — if no
  // pin exists the dispatch never verifiably landed, and nudging a resolved-by-label pane would
  // reopen that hole. Best-effort: false on any failure, never a throw.
  async nudge(slot: Slot, message: string): Promise<boolean> {
    const pinned = this.deliveredPanes.get(slot);
    if (!pinned) return false;
    try {
      await this.deliveryQueue(() => this.deliverTyped(slot, message, pinned));
      return true;
    } catch {
      return false; // the daemon journals worker-nudge-failed and falls back to the stall window
    }
  }

  // The narrator launches a perpetual shell watch, not an adapter-backed input interface — a shell
  // dispatch like any other, delivered atomically and acknowledged by its own START nonce.
  private async deliverPersistentShellCommand(slot: Slot, cmd: string): Promise<void> {
    return this.deliveryQueue(async () => {
      const pane = await this.paneId(slot);
      await this.deliverAtomic(slot, cmd, pane);
      this.deliveredPanes.set(slot, pane);
    });
  }

  private async submitVerifiedDelivery(
    slot: Slot,
    pane: string,
    inputBox: InputBox,
    readiness: DeliveryReadinessEvidence,
  ): Promise<void> {
    let transcript = "";
    // The base window preserves OBS-140's bounded behavior. A slow readiness observation grants
    // the same measured time once more for submit paint, capped by the readiness bound itself.
    const baseVerifyMs = (DELIVERY_SETTLE_READ_ATTEMPTS - 1) * DELIVERY_SETTLE_POLL_MS;
    const verifyWindowMs = Math.min(
      baseVerifyMs + readiness.timeoutMs,
      baseVerifyMs + readiness.waitedMs,
    );
    for (let attempt = 0; attempt < DELIVERY_SUBMIT_ATTEMPTS; attempt++) {
      const enter = await this.herdr(`pane send-keys ${shq(pane)} Enter`, slot.cwd);
      if (enter.code !== 0) throw new Error(`herdr pane send-keys Enter failed: ${enter.stderr || enter.stdout}`);

      // Reuse the existing settle-read window. A first-read success returns before any timer; only
      // a prompt that still occupies the delivery target spends the bounded settle window. This
      // verification always completes before a possible re-press, so a slow submit cannot duplicate.
      const settled = await this.settleDeliveryLine(
        pane,
        slot.cwd,
        transcript,
        inputBox,
        (candidate) => this.submissionRegistered(candidate, inputBox),
        verifyWindowMs,
      );
      transcript = settled.transcript;
      if (settled.ok) return;
      if (settled.readFailed) {
        throw new DeliveryCorruptedError(pane, "submission verification read failed, refusing to re-press Enter (OBS-140)", transcript);
      }
    }
    throw new DeliveryCorruptedError(pane, `${DELIVERY_SUBMIT_ATTEMPTS} submit attempts — submission never registered (OBS-140)`, transcript);
  }

  private async settleDeliveryLine(
    pane: string,
    cwd: string,
    initialTranscript: string,
    inputBox?: InputBox,
    accept?: (transcript: string) => boolean,
    settleWindowMs?: number,
  ): Promise<{ ok: boolean; transcript: string; recognizedInputBox: boolean; readFailed?: boolean }> {
    let transcript = initialTranscript;
    const readAttempts = settleWindowMs === undefined
      ? DELIVERY_SETTLE_READ_ATTEMPTS
      : Math.max(DELIVERY_SETTLE_READ_ATTEMPTS, Math.floor(settleWindowMs / DELIVERY_SETTLE_POLL_MS) + 1);
    for (let readAttempt = 0; readAttempt < readAttempts; readAttempt++) {
      const read = await this.herdr(
        `pane read ${shq(pane)} --source recent-unwrapped --lines ${DELIVERY_READ_LINES}`,
        cwd,
      );
      if (read.code !== 0) return { ok: false, transcript: read.stdout || transcript, recognizedInputBox: false, readFailed: true };
      if (accept?.(read.stdout)) {
        return {
          ok: true,
          transcript: read.stdout,
          recognizedInputBox: inputBox !== undefined && matchesInputBox(read.stdout, inputBox),
        };
      }
      if (accept === undefined && read.stdout === transcript) {
        return {
          ok: true,
          transcript,
          recognizedInputBox: inputBox !== undefined && matchesInputBox(transcript, inputBox),
        };
      }
      transcript = read.stdout;
      if (readAttempt < readAttempts - 1) {
        await this.time.sleep(DELIVERY_SETTLE_POLL_MS);
      }
    }
    return { ok: false, transcript, recognizedInputBox: false };
  }

  // Readiness now serves typed delivery only, so the target is always the adapter's declared box:
  // the "no declared box, so assume ready when the pane doesn't already show our command" branch is
  // gone with the rest of the typed-text inference (v1.85 T5).
  private async awaitDeliveryReadiness(
    slot: Slot,
    cmd: string,
    pane: string,
    inputBox: InputBox,
  ): Promise<DeliveryReadinessEvidence> {
    const timeoutMs = inputBox.readinessTimeoutMs ?? DELIVERY_READINESS_TIMEOUT_MS;
    const started = this.time.now();
    let previous: string | undefined;
    let transcript = "";
    let reads = 0;

    while (true) {
      const elapsedBeforeRead = this.time.now() - started;
      const remainingBeforeRead = timeoutMs - elapsedBeforeRead;
      if (remainingBeforeRead <= 0) throw new DeliveryReadinessError(elapsedBeforeRead, transcript);
      const read = await this.herdr(
        `pane read ${shq(pane)} --source recent-unwrapped --lines ${DELIVERY_READ_LINES}`,
        slot.cwd,
        Math.max(1, Math.ceil(remainingBeforeRead)),
      );
      reads++;
      transcript = read.stdout || transcript;
      const waitedMs = this.time.now() - started;
      if (read.code !== 0) {
        // Once at least one valid frame has been observed, a timed-out read IS the bounded window
        // expiring: the read was given exactly the remaining readiness budget as its real timeout,
        // so real time genuinely elapsed even when an injected clock has not advanced (an injected
        // clock never moves during a read, so a wall-clock comparison here can never hold under
        // one). A first-read timeout and every non-timeout read failure remain structural.
        if (read.timedOut && previous !== undefined) {
          throw new DeliveryReadinessError(waitedMs, transcript);
        }
        const detail = read.stderr || read.stdout || `exit ${read.code}`;
        throw new Error(`herdr pane read failed during readiness${read.timedOut ? " (timed out)" : ""}: ${detail}`);
      }

      if (previous !== undefined) {
        const stableFrame = read.stdout === previous;
        if (stableFrame && matchesInputBox(previous, inputBox) && matchesInputBox(read.stdout, inputBox)) {
          return { waitedMs, timeoutMs, transcript: read.stdout };
        }
      }
      previous = read.stdout;

      const remaining = timeoutMs - waitedMs;
      if (remaining <= 0) throw new DeliveryReadinessError(waitedMs, transcript);
      // The second read is immediate: an already-painted stable target proves readiness with no
      // added delay. Only observed change spends a poll interval, and every path remains bounded.
      if (reads > 1) {
        await this.time.sleep(Math.min(DELIVERY_SETTLE_POLL_MS, remaining));
      }
    }
  }

  private async deliveryReadMatches(pane: string, cmd: string, cwd: string): Promise<boolean> {
    const read = await this.herdr(`pane read ${shq(pane)} --source recent-unwrapped --lines ${DELIVERY_READ_LINES}`, cwd);
    return read.code === 0 && this.deliveryMatches(read.stdout, cmd);
  }

  private waitOk(code: number, stdout: string): boolean {
    if (code !== 0 || !stdout.trim()) return code === 0; // herdr's successful waits may be silent
    try {
      return !Object.hasOwn(JSON.parse(stdout), "error");
    } catch {
      return false; // a non-empty herdr wait response must be a parseable envelope
    }
  }

  async waitOutput(slot: Slot, pattern: string, timeoutMs: number, opts?: { regex?: boolean }): Promise<boolean> {
    const pane = await this.paneId(slot);
    // 0.7.5: `--match` (literal) and `--regex` (pattern) are MUTUALLY EXCLUSIVE — the old
    // `--match <p> --regex` form is rejected ("mutually exclusive"), which made the exit-marker wait
    // error instantly instead of waiting, so LLM-gate/consult verdicts were read before they rendered
    // and came back unparseable. Pick exactly one flag by whether the caller wants regex.
    const r = await this.herdr(
      `pane wait-output ${shq(pane)} ${opts?.regex ? "--regex" : "--match"} ${shq(pattern)} --timeout ${Math.floor(timeoutMs)}`,
      slot.cwd,
      timeoutMs + 15_000,
    );
    return this.waitOk(r.code, r.stdout); // dead pane: exit 0 + top-level error envelope (herdr bite)
  }

  async waitAgentStatus(slot: Slot, status: string, timeoutMs: number): Promise<boolean> {
    const pane = await this.paneId(slot);
    // 0.7.5: `wait agent-status` (top-level) was removed; `agent wait <target> --until <status>` replaces
    // it. Target is the pane id; when herdr has detected the worker's agent CLI there this resolves, else
    // it returns an error envelope → waitOk false (a best-effort settle, same as the old timeout path).
    const r = await this.herdr(
      `agent wait ${shq(pane)} --until ${shq(status)} --timeout ${Math.floor(timeoutMs)}`,
      slot.cwd,
      timeoutMs + 15_000,
    );
    return this.waitOk(r.code, r.stdout);
  }

  async status(slot: Slot): Promise<string> {
    return this.statusByName(slot.name);
  }

  // shared by status() and the VIS-13 blocked glyph (renameGroupTab): resolve the live agent_status
  // by durable name; "unknown" on any failure (dead pane, unparseable json) — never throws.
  private async statusByName(name: string): Promise<string> {
    // 0.7.5: read the pane's herdr-detected agent_status off `pane list` (keyed by the durable label);
    // "unknown" on any failure (no such label, unparseable json) — never throws.
    const r = await this.herdr(`pane list`);
    try {
      const panes = JSON.parse(r.stdout).result?.panes;
      const hit = Array.isArray(panes) ? panes.find((p: { label?: string; agent_status?: string }) => p.label === name) : undefined;
      const s = hit?.agent_status;
      return typeof s === "string" ? s : "unknown";
    } catch {
      return "unknown";
    }
  }

  async read(slot: Slot, lines: number): Promise<string> {
    const pane = await this.paneId(slot);
    const r = await this.herdr(`pane read ${shq(pane)} --source recent-unwrapped --lines ${lines}`, slot.cwd);
    return r.stdout;
  }

  // v1.22 T5 / OBS-19: raw keystroke into the pane TUI (trust-dialog auto-answer). Resolves the pane
  // id fresh like every other pane-addressed call (ids compact). Fail closed on nonzero herdr exit.
  async sendKey(slot: Slot, key: string): Promise<void> {
    const pane = await this.paneId(slot);
    const r = await this.herdr(`pane send-keys ${shq(pane)} ${shq(key)}`, slot.cwd);
    if (r.code !== 0) throw new Error(`herdr pane send-keys failed: ${r.stderr || r.stdout}`);
  }

  async notify(msg: string, opts?: NotifyOpts): Promise<void> {
    if (opts?.tier === "routine") return;
    await this.herdr(`notification show ${shq(msg)} --sound ${opts?.tier === "attention" ? "request" : opts?.sound ?? "request"}`);
  }

  async close(slot: Slot): Promise<void> {
    if (this.watches.get(slot.name)?.id === slot.id) {
      this.watches.delete(slot.name);
      const pane = await this.namedPaneId(slot.name);
      if (pane) await this.herdr(`pane close ${shq(pane)}`);
      return; // run-end reconcile may already have reaped it; never close a compacted stale id
    }
    if (slot.group && this.groups.has(slot.group)) {
      return this.serial(() => this.closeGrouped(slot));
    }
    if (slot.tabId) {
      await this.herdr(`tab close ${shq(slot.tabId)}`); // reaps the slot's whole tab, best-effort
      return;
    }
    const pane = await this.paneId(slot);
    await this.herdr(`pane close ${shq(pane)}`); // best-effort
  }

  // D-08 ref-counted teardown, PER GENERATION (VIS-09 item 2): pane close per member; a generation's
  // tab closes only when ITS OWN last member leaves; the group entry dies when all generations are gone.
  // C2's "resolve the newest LIVE member" rule applies per generation — members[] holds only live members.
  private async closeGrouped(slot: Slot): Promise<void> {
    const state = this.groups.get(slot.group!);
    if (!state) return; // group already torn down — its tabs are gone
    // find THIS member's generation by tab id: each overflow tab closes when its own last member leaves
    const gen = state.generations.find((g) => g.tabId === slot.tabId);
    if (!gen) return; // generation already torn down — its tab is gone
    const pane = await this.paneId(slot);
    await this.herdr(`pane close ${shq(pane)}`); // best-effort
    gen.members = gen.members.filter((m) => m.name !== slot.name);
    await this.renameGroupTab(gen);
    if (gen.members.length === 0) {
      await this.herdr(`tab close ${shq(gen.tabId)}`); // refcount 0 → reap THIS generation's tab only
      state.generations = state.generations.filter((g) => g.tabId !== gen.tabId);
      if (state.generations.length === 0) this.groups.delete(slot.group!); // group dies when all generations gone
    }
  }

  private async priorWatch(runId: string): Promise<string | null> {
    if (!this.ws) throw new Error("herdr watch placement requires HERDR_WORKSPACE_ID — refusing unseeded pane");
    const list = await this.herdr("pane list");
    if (list.code !== 0) throw new Error(`herdr pane list failed: ${list.stderr || list.stdout}`);
    let panes: { label?: string; pane_id?: string; workspace_id?: string }[];
    try {
      panes = JSON.parse(list.stdout).result?.panes;
    } catch {
      throw new Error(`herdr pane list returned unparseable JSON: ${list.stdout}`);
    }
    if (!Array.isArray(panes)) throw new Error(`herdr pane list returned no panes: ${list.stdout}`);
    const prior = panes.find((p) => {
      const owned = typeof p.label === "string" ? parseOwnedName(p.label) : null;
      return p.workspace_id === this.ws && typeof p.pane_id === "string" && owned?.role === "watch" && owned.taskId === "run" && owned.runId !== runId;
    });
    return prior?.pane_id ?? null;
  }

  // T2: the watch is a rightward sibling of the daemon's own pane, never a separate tab. Its durable
  // owned name lets a resumed daemon find an already-running watch instead of stacking another one.
  private async watchSlot(cwd: string, name: string): Promise<Slot> {
    if (!this.ws) throw new Error("herdr watch placement requires HERDR_WORKSPACE_ID — refusing unseeded pane");
    if (!this.callerPane) throw new Error("herdr watch placement requires HERDR_PANE_ID — refusing untargeted split");
    const sp = await this.herdr(`pane split ${shq(this.callerPane)} --direction right --no-focus`);
    if (sp.code !== 0) throw new Error(`herdr watch split failed: ${sp.stderr || sp.stdout}`);
    let pane: string | undefined;
    try {
      pane = JSON.parse(sp.stdout).result?.pane?.pane_id;
    } catch {
      /* fail closed below */
    }
    if (typeof pane !== "string" || !pane) throw new Error(`herdr watch split returned no pane id: ${sp.stdout}`);
    const renamed = await this.herdr(`pane rename ${shq(pane)} ${shq(name)}`);
    if (renamed.code !== 0 || await this.namedPaneId(name) !== pane) {
      await this.herdr(`pane close ${shq(pane)}`);
      throw new Error(`herdr watch rename failed: ${renamed.stderr || renamed.stdout}`);
    }
    const seed = await this.herdr(
      `pane run ${shq(pane)} ${shq(`cd ${shq(cwd)}; export HERDR_WORKSPACE_ID=${shq(this.ws)}; ${herdrSealShellPrefix()}`)}`,
      cwd,
    );
    if (seed.code !== 0) {
      await this.herdr(`pane close ${shq(pane)}`);
      throw new Error(`herdr watch seed failed: ${seed.stderr || seed.stdout}`);
    }
    return { id: pane, name, cwd };
  }

  // T6 narrator: the run's single live status surface. Reuse a local or already-running owned watch;
  // a new run reowns its prior watch, and only a newly split pane receives the watch command. The
  // status command reads the latest run every frame, so the renamed pane follows the new run without
  // interrupting the operator's watch loop. Failures propagate — the daemon swallows.
  async narrator(cwd: string, command: string, runId?: string): Promise<Slot> {
    const name = runId ? formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }) : `narrator-watch-${process.pid}`;
    return this.serial(async () => {
      const cached = this.watches.get(name);
      if (cached) return cached;
      const existing = await this.namedPaneId(name);
      if (existing) {
        const s = { id: existing, name, cwd };
        this.watches.set(name, s);
        return s;
      }
      const prior = runId ? await this.priorWatch(runId) : null;
      if (prior) {
        const renamed = await this.herdr(`pane rename ${shq(prior)} ${shq(name)}`);
        if (renamed.code !== 0 || await this.namedPaneId(name) !== prior) {
          throw new Error(`herdr watch reclaim failed: ${renamed.stderr || renamed.stdout}`);
        }
        const s = { id: prior, name, cwd };
        this.watches.set(name, s);
        return s;
      }
      const s = await this.watchSlot(cwd, name);
      this.watches.set(name, s);
      try {
        await this.deliverPersistentShellCommand(s, command);
      } catch (err) {
        this.watches.delete(name);
        throw err;
      }
      return s;
    });
  }

  // OBS-17 T2 / v1.22b T1: close every tickmarkr-owned pane that should not exist (superseded attempts,
  // killed-daemon orphans, leftovers from OLDER runs) — in this run's workspace OR misplaced in any
  // other one — then reap the tabs those closes emptied. Ownership is decided ONLY by parseOwnedName
  // (drivers/types.ts panesToClose) — foreign names never become candidates, in any workspace; a pane
  // this same run legitimately holds elsewhere is left alone (only run age marks a misplaced pane
  // garbage). spareLiveLlm: same-run judge/review/consult panes have no journal row while live (their
  // events land after the verdict is read), so mid-run sweeps spare them; boundary sweeps (start/
  // resume/end) run with nothing in flight and take them too. Cosmetic by contract: every failure —
  // herdr gone, pane vanished mid-sweep, unparseable listing — is swallowed; this method never throws.
  async reconcile(desired: Set<string>, runId: string, opts?: { spareLiveLlm?: boolean }): Promise<void> {
    try {
      if (!this.ws) return;
      // 0.7.5: enumerate owned panes from `pane list` (labels), not `agent list` (detected agents only).
      // panesToClose skips any pane whose label doesn't parse as tickmarkr-owned (orchestrator/operator
      // shells, undetected agents), so a fuller pane listing never widens the blast radius.
      const list = await this.herdr("pane list");
      const panes: { label?: string; pane_id?: string; tab_id?: string; workspace_id?: string }[] =
        JSON.parse(list.stdout).result?.panes ?? [];
      const toClose = panesToClose(
        panes.map((p) => ({ name: p.label, paneId: p.pane_id, tabId: p.tab_id, workspaceId: p.workspace_id })),
        desired,
        this.ws,
        runId,
        opts,
      );
      const touched = new Set<string>();
      for (const c of toClose) {
        if (typeof c.tabId === "string") touched.add(c.tabId);
        await this.herdr(`pane close ${shq(c.paneId)}`); // best-effort — a vanished pane is already reconciled
      }
      if (touched.size === 0) return;
      // a tab our closes emptied was ours by construction (a tab with operator panes still has panes)
      const pl = await this.herdr("pane list");
      const alive = new Set(
        (JSON.parse(pl.stdout).result?.panes ?? []).map((p: { tab_id?: string }) => p.tab_id),
      );
      for (const tab of touched) if (!alive.has(tab)) await this.herdr(`tab close ${shq(tab)}`);
    } catch {
      /* cosmetic — visibility hygiene never fails the run */
    }
  }

  async worktree(repo: string, branch: string, baseRef: string): Promise<string> {
    const worktree = await createWorktree(repo, branch, baseRef);
    this.journalRoots.set(repo, repo);
    this.journalRoots.set(worktree, repo);
    return worktree;
  }
}
