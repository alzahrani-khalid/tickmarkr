import { shq } from "../adapters/types.js";
import { PANE_IDENTITY_ENV, paneIdentityLine } from "../brand.js";
import { createWorktree, sh } from "../run/git.js";
import { herdrSealShellPrefix } from "./subprocess.js";
import { canonicalizeLegacyName, formatOwnedName, panesToClose, parseOwnedName, type ExecutorDriver, type NotifyOpts, type Slot, type SlotOpts } from "./types.js";

// VIS-09 P43-03: adopted safety floor from 43-MEASUREMENT.md (narrowest safe 53 → floor 108).
export const TRAILER_SAFE_FLOOR_COLS = 108;
export const TRAILER_WIDTH_MARGIN = 2; // cols below (floor + margin) refuse a rightward first split

// OBS-85 verified delivery: bounded type→read-back→enter attempts before failing closed.
export const DELIVERY_ATTEMPTS = 3;
const DELIVERY_VERIFY_TIMEOUT_MS = 2000; // per attempt — a paste that hasn't rendered in 2s is retyped
const DELIVERY_READ_LINES = 80;

/** First-generation join direction from measured trailer-safe floor (43-MEASUREMENT.md). */
export function workerSplitDirection(paneCols: number | null, safeFloor = TRAILER_SAFE_FLOOR_COLS, margin = TRAILER_WIDTH_MARGIN): "right" | "down" {
  if (paneCols == null || paneCols <= 0) return "down";
  return paneCols / 2 >= safeFloor + margin ? "right" : "down";
}

// VIS-04 role-tab + VIS-09 item 2 cap/overflow: live members of one ref-counted tab (a GENERATION);
// a group holds N generations (WORKERS, cleanup, cleanup, …), each its own tab, cap-bounded. Teardown
// is refcounted PER GENERATION: each overflow tab closes when its OWN last member leaves (43-02).
interface GroupEntry { tabId: string; label: string; members: { name: string; paneId: string }[] }
// splitUnsupported is PER GROUP (a herdr that can't split can't split in any tab); `created` is a
// monotonic generation counter so distinct overflow generations never collide as objects (VIS-13:
// overflow labels are all "cleanup" — distinguished by their live member token, never a WORKERS-N).
interface GroupState { generations: GroupEntry[]; created: number; splitUnsupported?: boolean }

export class HerdrDriver implements ExecutorDriver {
  id = "herdr";
  interactive = true;

  private groups = new Map<string, GroupState>();
  // grouped slot()/close() mutate shared group state across awaits — serialize them so two
  // concurrent first members can never both create the group tab (mergeSerial idiom, daemon.ts)
  private groupSerial: Promise<unknown> = Promise.resolve();
  // OBS-119: concurrent deliveries contend on herdr's send path — one chain per driver (mergeSerial idiom)
  private deliverySerial: Promise<unknown> = Promise.resolve();

  // VIS-10: the run's workspace id, captured once at construction (the daemon inherits it from the
  // operator's env before the driver is built). Required at slot() time, never in the constructor —
  // pickDriver and its unit test construct HerdrDriver without env, so slot() is the trust gate.
  private ws = process.env.HERDR_WORKSPACE_ID;
  private callerPane = process.env.HERDR_PANE_ID;
  private watches = new Map<string, Slot>();

  constructor(private bin = "herdr", private workersPerTab = 3) {}

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

  // ponytail: narrow panes hard-wrap the input line — collapse whitespace before comparing.
  private deliveryMatches(transcript: string, cmd: string): boolean {
    const norm = (s: string) => s.replace(/\s+/g, "");
    const hay = norm(transcript);
    const needle = norm(cmd);
    return needle.length > 0 && hay.includes(needle);
  }

  static available(): boolean {
    return process.env.HERDR_ENV === "1";
  }

  private herdr(args: string, cwd = process.cwd(), timeoutMs?: number) {
    return sh(`${shq(this.bin)} ${args}`, cwd, timeoutMs);
  }

  private async namedPaneId(name: string): Promise<string | null> {
    const r = await this.herdr(`agent get ${shq(name)}`);
    if (r.code !== 0) return null;
    try {
      const id = JSON.parse(r.stdout).result?.agent?.pane_id;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  // pane ids compact when panes close — resolve fresh via the durable agent name (spec §5)
  private async paneId(slot: Slot): Promise<string> {
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
    // T1 ownership contract: `opts.owned` (T2 call sites) names the pane canonically —
    // tickmarkr:<role>:<taskId>:<attempt>:<runId>. Without it, `name` passes through byte-identical
    // (today's legacy daemon/gates/consult shapes) — canonicalizeLegacyName (types.ts) is what lets
    // reconcile.ts and this driver's own renameGroupTab/glyphFor decode role/taskId/attempt from
    // those shapes without a call-site migration; T2 retires this branch by always passing `owned`.
    const resolved = opts?.owned ? formatOwnedName(opts.owned) : name;
    // group wins if both are set (a group tab is already stage-labeled; passing both is a caller bug).
    // label (without group) → dedicated labeled tab via tabSlot's third param: no groups-map entry, no
    // refcount, no groupSerial, no degrade latch — dedicated tabs have no shared state to guard (SUP-01).
    if (opts?.group) return this.serial(() => this.groupSlot(cwd, resolved, opts.group!));
    return this.tabSlot(cwd, resolved, opts?.label); // label undefined → defaults to name (today's behavior)
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
    const t = await this.herdr(`tab create --label ${shq(label)} --no-focus --workspace ${shq(this.ws)}`);
    if (t.code !== 0) throw new Error(`herdr tab create failed (exit ${t.code}, refusing untargeted placement): ${t.stderr || t.stdout}`);
    let res: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } };
    try {
      res = JSON.parse(t.stdout).result;
    } catch {
      throw new Error(`herdr tab create returned unparseable JSON (refusing untargeted placement): ${t.stdout}`);
    }
    const tabId = res?.tab?.tab_id;
    const rootPane = res?.root_pane?.pane_id; // auto-created shell pane (SKILL:343)
    if (typeof tabId !== "string" || !tabId) throw new Error(`herdr tab create returned no tab_id (refusing untargeted placement): ${t.stdout}`);
    // T5: the banner's pane identity line, derived from the T1 owned name (legacy names pass through).
    const identity = shq(paneIdentityLine(canonicalizeLegacyName(name, "")));
    let r = await this.herdr(`agent start ${shq(name)} --cwd ${shq(cwd)} --tab ${shq(tabId)} --no-focus -- bash`);
    if (r.code !== 0 && /agent_name_taken/.test(r.stderr + r.stdout)) {
      // DEFECT-01: a prior (killed) process's kept pane still holds this durable name — reclaim it.
      // The old attempt is void by construction: its worktree was rm -rf'd on re-dispatch (git.ts:34),
      // so adoption is meaningless; close the stale PANE only (never its tab — sibling prior-run panes
      // may still be under the operator's eye) and restart. Match BOTH streams (herdr's error-stream
      // convention varies — Pitfall 6); an unrelated nonzero exit must never reach pane close (T-10-04).
      const g = await this.herdr(`agent get ${shq(name)}`);
      try {
        const stale = JSON.parse(g.stdout).result?.agent?.pane_id;
        if (typeof stale === "string" && stale) await this.herdr(`pane close ${shq(stale)}`);
      } catch {
        /* holder vanished between calls (agent_not_found) — retry the start regardless */
      }
      r = await this.herdr(`agent start ${shq(name)} --cwd ${shq(cwd)} --tab ${shq(tabId)} --no-focus -- bash`); // once
    }
    if (r.code !== 0) throw new Error(`herdr agent start failed: ${r.stderr || r.stdout}`); // fail closed, no loop
    const id = JSON.parse(r.stdout).result?.agent?.pane_id;
    if (typeof id !== "string" || !id) throw new Error(`herdr agent start returned no pane id: ${r.stdout}`);
    // tab create auto-spawns a root shell pane and agent start --tab adds the agent as a SECOND
    // pane — reap the idle shell so no tab shows a dead "tickmarkr git:" prompt beside its agent
    // (VIS-04 orphan fix). Best-effort: a failed reap costs cosmetics only.
    if (typeof rootPane === "string" && rootPane && rootPane !== id) {
      await this.herdr(`pane close ${shq(rootPane)}`);
    }
    // VIS-10 hole 3: seed the run's workspace id into the agent pane's shell so a worker's own ad-hoc
    // `herdr agent start` is workspace-targeted BY CONSTRUCTION — correct placement is the default a
    // worker GETS, not a rule it must remember (P40-02 probe leak). Fail closed: a failed seed rejects.
    // v1.22 T3 / OBS-17: also strip HERDR_ENV + socket path so the worker cannot open/mutate panes in
    // the operator's session. Daemon-side this.herdr() calls keep process.env (unsealed).
    const seed = await this.herdr(
      `pane run ${shq(id)} ${shq(`export HERDR_WORKSPACE_ID=${shq(this.ws)}; export ${PANE_IDENTITY_ENV}=${identity}; ${herdrSealShellPrefix()}`)}`,
    );
    if (seed.code !== 0) throw new Error(`herdr workspace-id seed failed (refusing untargeted pane): ${seed.stderr || seed.stdout}`);
    return { id, name, cwd, tabId };
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
      if (latest && latest.members.length < this.workersPerTab) {
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
    const label = token ? `${entry.label} · ${token}${glyph}` : entry.label;
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
    const sp = await this.herdr(`pane split ${shq(srcPane)} --direction ${direction} --no-focus`);
    if (sp.code !== 0) return null;
    let pane: string | undefined;
    try {
      pane = JSON.parse(sp.stdout).result?.pane?.pane_id ?? undefined;
    } catch {
      /* fall through to degrade */
    }
    if (typeof pane !== "string" || !pane) return null;
    // the split pane is a bare shell: give it a durable agent name (SKILL:197) and VERIFY the name
    // resolves back to this pane (research A1 is checked live per join, never assumed) — then cd the
    // shell into this member's own worktree (a split inherits its parent's cwd, not ours).
    const rn = await this.herdr(`agent rename ${shq(pane)} ${shq(name)}`);
    const verified = rn.code === 0 && (await this.paneId({ id: "", name, cwd })) === pane;
    const cd = verified ? await this.herdr(`pane run ${shq(pane)} ${shq(`cd ${shq(cwd)}`)}`) : null;
    if (!cd || cd.code !== 0) {
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

  // OBS-85 verified delivery: a pane paste can interleave a long dispatch line with itself (codex
  // `$(git rev-parse…)` mashed into its trailing printf — v1.58 T2 attempts 2-4, v1.61 T10). Never
  // the atomic `pane run` (text+Enter in one request, uninspectable between the two): type WITHOUT
  // enter, read the pane back — `wait output --match` checks the same unwrapped transcript pane
  // read exposes, event-driven so wrap and render timing can't race the check — and press Enter
  // only when that read-back contains the typed command. A corrupted paste is captured (pane read),
  // cleared (C-u), and retyped, bounded; persistent corruption fails closed WITH the captured
  // transcript — the dispatch-time pincer the ledger asks for, not post-hoc `git:` archaeology.
  async run(slot: Slot, cmd: string): Promise<void> {
    return this.deliveryQueue(() => this.deliver(slot, cmd));
  }

  private async deliver(slot: Slot, cmd: string): Promise<void> {
    const pane = await this.paneId(slot);
    let transcript = "";
    for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // clear the corrupted input line before retyping; a failed clear must NOT be retyped onto —
        // corrupt-prefix + clean-retype would concatenate and false-verify by containment
        const cleared = await this.herdr(`pane send-keys ${shq(pane)} C-u`, slot.cwd);
        if (cleared.code !== 0) throw new Error(`herdr delivery clear failed — refusing to retype onto a corrupted line (OBS-85); pane transcript:\n${transcript}`);
      }
      const typed = await this.herdr(`pane send-text ${shq(pane)} ${shq(cmd)}`, slot.cwd);
      if (typed.code !== 0) throw new Error(`herdr pane send-text failed: ${typed.stderr || typed.stdout}`);
      const back = await this.herdr(
        `wait output ${shq(pane)} --match ${shq(cmd)} --timeout ${DELIVERY_VERIFY_TIMEOUT_MS}`,
        slot.cwd,
        DELIVERY_VERIFY_TIMEOUT_MS + 15_000,
      );
      if (this.waitOk(back.code, back.stdout) || await this.deliveryReadMatches(pane, cmd, slot.cwd)) {
        const enter = await this.herdr(`pane send-keys ${shq(pane)} Enter`, slot.cwd);
        if (enter.code !== 0) throw new Error(`herdr pane send-keys Enter failed: ${enter.stderr || enter.stdout}`);
        return;
      }
      // capture the corrupted delivery BEFORE clearing it — the OBS-85 byte-level evidence
      transcript = (await this.herdr(`pane read ${shq(pane)} --source recent-unwrapped --lines ${DELIVERY_READ_LINES}`, slot.cwd)).stdout;
    }
    throw new Error(`herdr delivery corrupted after ${DELIVERY_ATTEMPTS} attempts — enter never pressed (OBS-85); pane transcript:\n${transcript}`);
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
    const r = await this.herdr(
      `wait output ${shq(pane)} --match ${shq(pattern)}${opts?.regex ? " --regex" : ""} --timeout ${Math.floor(timeoutMs)}`,
      slot.cwd,
      timeoutMs + 15_000,
    );
    return this.waitOk(r.code, r.stdout); // dead pane: exit 0 + top-level error envelope (herdr bite)
  }

  async waitAgentStatus(slot: Slot, status: string, timeoutMs: number): Promise<boolean> {
    const pane = await this.paneId(slot);
    const r = await this.herdr(
      `wait agent-status ${shq(pane)} --status ${shq(status)} --timeout ${Math.floor(timeoutMs)}`,
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
    const r = await this.herdr(`agent get ${shq(name)}`);
    try {
      const s = JSON.parse(r.stdout).result?.agent?.agent_status;
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
    const list = await this.herdr("agent list");
    if (list.code !== 0) throw new Error(`herdr agent list failed: ${list.stderr || list.stdout}`);
    let agents: { name?: string; pane_id?: string; workspace_id?: string }[];
    try {
      agents = JSON.parse(list.stdout).result?.agents;
    } catch {
      throw new Error(`herdr agent list returned unparseable JSON: ${list.stdout}`);
    }
    if (!Array.isArray(agents)) throw new Error(`herdr agent list returned no agents: ${list.stdout}`);
    const prior = agents.find((a) => {
      const owned = typeof a.name === "string" ? parseOwnedName(a.name) : null;
      return a.workspace_id === this.ws && typeof a.pane_id === "string" && owned?.role === "watch" && owned.taskId === "run" && owned.runId !== runId;
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
    const renamed = await this.herdr(`agent rename ${shq(pane)} ${shq(name)}`);
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
        const renamed = await this.herdr(`agent rename ${shq(prior)} ${shq(name)}`);
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
        await this.run(s, command);
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
      const list = await this.herdr("agent list");
      const agents: { name?: string; pane_id?: string; tab_id?: string; workspace_id?: string }[] =
        JSON.parse(list.stdout).result?.agents ?? [];
      const toClose = panesToClose(
        agents.map((a) => ({ name: a.name, paneId: a.pane_id, tabId: a.tab_id, workspaceId: a.workspace_id })),
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

  worktree(repo: string, branch: string, baseRef: string): Promise<string> {
    return createWorktree(repo, branch, baseRef);
  }
}
