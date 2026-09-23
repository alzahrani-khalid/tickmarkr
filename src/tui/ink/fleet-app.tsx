import { Box, render, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import { MODEL_ID_RE, type AuthHealth, type WorkerAdapter } from "../../adapters/types.js";
import { retiredModelReason } from "../../adapters/model-lints.js";
import { DENY_SCOPES, denyBlockFrom, denyEntriesAt, initialDenyPropOf, stagedDenyKeyOf, type DenyScope, type DenyScopeKey, type InitialDenyProps, type MapEntry, type RoutingMode, type StagedDenyKey, type Tier, type TickmarkrConfig } from "../../config/config.js";
import { fleetFirstTouchProvenance } from "../../config/fleet-overlay.js";
import { exclusionReason } from "../../config/fleet-why.js";
import { entryMatchesChannel, exclusionCollector, type ExclusionScope, type PreferenceRole } from "../../route/preference.js";
import { TIERS, type Shape } from "../../graph/schema.js";
import { windowRows } from "./components.js";
import {
  clip,
  clipPathTail,
  ElisionMark,
  enterAltScreen,
  fmtCtx,
  fmtMs,
  fmtUsdPair,
  Glyph,
  INK,
  inkInput,
  inkOutput,
  KeyBar,
  type KeyBind,
  OverlayPanel,
  padCell,
  padCellStart,
  Pointer,
  SearchRow,
} from "./frame.js";

export type FleetSteeringKey = "review" | "consult";
const STEERING_KEYS: FleetSteeringKey[] = ["review", "consult"];

// OBS-1099 add.1: one staged list per schema-enumerated deny scope, keyed as FleetEditable — a
// scope the schema gains is carried here without a hand field (the command bridge copies it over).
export type FleetEditorState = Record<DenyScopeKey, string[]> & {
  /** OBS-1046: the staged routing.allow complement, distinct from the authored deny lists above */
  allowOut?: string[];
  classifications: FleetClassification[];
  selectedMode: RoutingMode;
  map: Record<string, MapEntry>;
  // v1.61: one seat, not a chain — config.judge is z.object({ adapter, model }) (GATE-09 failover
  // is runtime). Present only when the operator picked a seat in the editor.
  judgeSeat?: { adapter: string; model: string };
  steering: Record<FleetSteeringKey, string[] | undefined>;
};

export type FleetOverlayReview =
  | { kind: "empty" }
  | {
    kind: "diff";
    before: string;
    after: string;
    diff: string;
    path: string;
  };

export type FleetEditorResult =
  | { kind: "write"; review: Extract<FleetOverlayReview, { kind: "diff" }> }
  | { kind: "discard" }
  | { kind: "no-changes" }
  | { kind: "quit" }
  | { kind: "refresh" };

type AgentCli = {
  id: string;
  version: string;
  authed: boolean;
};

export type FleetModelSuggestion = { tier: Tier; note: string };

/** Catalog + probe metadata rendered as the browser's metadata columns (omp-style). */
export type FleetModelEvidence = {
  contextWindow?: number;
  outputWindow?: number;
  inputCostPerMtok?: number;
  outputCostPerMtok?: number;
  /** doctor's model probe wall clock (modelAuth.durationMs) — the "how fast did it answer" column */
  probeMs?: number;
  /** OBS-519: doctor's failed model-auth verdict reason — the row must not render like a healthy one */
  unauthed?: string;
  /** OBS-972/FL-1: a floating alias's resolved concrete model id (e.g. "opus" → "claude-opus-5") */
  identity?: string;
};

/** OBS-1099 add.1: the staged deny list of every schema-enumerated scope — keyed by the scope
 * key minus its `deny` prefix (denyWorkersAdapters → workersAdapters) — every preview and the
 * staged routing policy are computed from; a scope the schema gains is a key here, not a hand field. */
export type FleetStagedDeny = Record<StagedDenyKey, string[]> & {
  /** OBS-1046: the staged routing.allow complement; absent ⇒ the session's initial one */
  allowOut?: string[];
};
/** every scope's staged list, empty — the "every policy scope open" probe the picker lifts against */
export const openStagedDeny = (): FleetStagedDeny => ({
  ...(Object.fromEntries(DENY_SCOPES.map((scope) => [stagedDenyKeyOf(scope), [] as string[]])) as Record<StagedDenyKey, string[]>),
  allowOut: [],
});

export type FleetModelGroup = {
  adapter: string;
  vendor?: string;
  /** configured billing channel (cfg.tiers.<adapter>.channel) — prices render for api, quota for sub */
  channel?: "sub" | "api";
  // OBS-508: `suggestion` is catalog evidence (catalogModelAdvisory) — prefills the classify flow
  // and feeds the bulk `s` stage; tickmarkr still never WRITES a tier without the review diff.
  rows: Array<{
    model: string;
    tier?: Tier;
    detectedAt?: string;
    suggestion?: FleetModelSuggestion;
    evidence?: FleetModelEvidence;
    classifyModel?: string;
    variants?: string[];
    foldedModels?: string[];
    score?: number;
  }>;
};

export type FleetClassification = {
  adapter: string;
  model: string;
  tier: Tier;
  note: string;
  vendor?: string;
  channel?: "sub" | "api";
};

export type FleetModeOption = {
  id: RoutingMode;
  gloss: string;
};

export type FleetShapeRow = {
  id: Shape;
  label: string;
};

export type FleetCandidateOption = {
  id: string;
  label: string;
  pin: { via: string; model: string };
  /** ranked only after the shape's advisory floor was dropped (candidates.ts) — never lift-eligible */
  belowFloor?: boolean;
};

const CHANNELS = ["sub", "api"] as const;

export function formatDoctorAge(ageMs: number | null): string {
  if (ageMs === null) return "no probe data";
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m old`;
  return `${Math.floor(mins / 60)}h old`;
}

// judge seats travel the editor as the same "adapter:model" strings the pickers list; the model
// half may itself contain ":" so only the first separator is structural.
function splitSeat(seat: string): { adapter: string; model: string } {
  const at = seat.indexOf(":");
  return { adapter: seat.slice(0, at), model: seat.slice(at + 1) };
}

type View = "models" | "shapes" | "steering";
type DiffReview = Extract<FleetOverlayReview, { kind: "diff" }>;

type ClassifyBulk = { adapter: string; vendor: string; rows: Array<{ model: string; suggestion: FleetModelSuggestion }> };

/** OBS-530: `excludedNote` names the channels the picker CANNOT offer (staged out, denied,
 * unauthed, unclassified) — the picker's silence was indistinguishable from a bug. */
type CandidatesOverlay = {
  kind: "candidates";
  shape: Shape;
  rows: FleetCandidateOption[];
  excludedNote?: string;
  /** LEG2-T3 round 2 finding 4: one line per channel naming its reasons — navigable rows below the
   * candidates, so no explanation is ever elided on a short terminal */
  ledger: string[];
  chain: string[];
  at: number;
};

type Overlay =
  | { kind: "presets"; at: number; home: boolean }
  | {
    kind: "classify";
    adapter: string;
    model: string;
    displayModel?: string;
    vendor?: string;
    stage: "channel" | "tier" | "note";
    channelAt: number;
    tierAt: number;
    note: string;
    suggestion: FleetModelSuggestion | null;
    /** a bulk `s` stage waiting on the one first-touch channel answer */
    bulk?: ClassifyBulk;
  }
  | { kind: "add-model"; adapter: string; text: string }
  | { kind: "assign"; adapter: string; model: string; at: number }
  | CandidatesOverlay
  // the tiny mode question a non-empty pool selection commits through — Esc restores `picker`
  // (its chain and cursor intact); Enter stages { pool: { mode, channels: chain } } on the shape
  | { kind: "poolmode"; picker: CandidatesOverlay; at: number }
  | { kind: "prefer"; target: { shape: Shape } | { steering: FleetSteeringKey }; rows: string[]; chain: string[]; at: number }
  | { kind: "judge"; at: number }
  // OBS-1099 items 1 and 4: the reach picker — one selected reason changes per act, never a cycle
  | { kind: "reach"; target: { adapter: string; model?: string }; at: number }
  // OBS-1099 items 2/3, OBS-1065: the ONE entry-level owning control — lists every identity the
  // covering entry reaches, then Enter lifts that one logical entry
  | { kind: "lift"; id: string; covering: Covering }
  | { kind: "review"; review: DiffReview; scroll: number };

type SeatChannel = { adapter: string; model: string; identity?: string };
/** a deny entry that reaches this row other than by its own adapter:model key, with every
 * displayed channel it covers; `shared` ⇒ never a row edit, only the lift control */
type Owned = { entry: string; scope: string };
/** review round 12: the ONE entry each reach choice edits on this row, from the same ordered
 * selector the mutation reads — the detail line names them per choice, never a merged promise */
type ReachEdits = { clear?: Owned; demote?: Owned; promote?: Owned };
type Covering = { entry: string; scope: string; covers: string[]; shared: boolean; edits: ReachEdits };

type ReachChoice = "in" | "out-workers" | "out-all";
const REACH_CHOICES: Array<{ id: ReachChoice; label: string; gloss: string }> = [
  { id: "in", label: "in", gloss: "every seat may route here" },
  { id: "out-workers", label: "out · workers", gloss: "workers skip it; judge/review/consult unaffected" },
  { id: "out-all", label: "out · all seats", gloss: "no seat routes here" },
];

type RailRow =
  | { kind: "view"; view: View; label: string; count: number }
  | { kind: "adapter"; index: number };

// OBS-994/FL-1: a channel's fleet reach — "in" (every role), "out-workers" (worker seats only
// excluded, judge/review/consult unaffected), "out-all" (a flat deny excludes it for every role) or
// "out-allow" (every role, because routing.allow does not admit it).
// "unknown" means the staged policy itself does not load (judge c2): no reach is claimed.
export type FleetReach = "in" | "out-workers" | "out-all" | "out-allow" | "unknown";

/** The staged routing policy, or the loader's refusal of the staged overlay. */
export type FleetStagedRouting = { ok: true; routing: TickmarkrConfig["routing"] } | { ok: false; error: string };

type ModelRow = {
  adapter: string;
  model: string;
  tier?: Tier;
  detectedAt?: string;
  suggestion?: FleetModelSuggestion;
  evidence?: FleetModelEvidence;
  channel?: "sub" | "api";
  classifyModel?: string;
  variants?: string[];
  foldedModels?: string[];
  score?: number;
  denied: boolean;
  reach: FleetReach;
  /** every exclusion-collector scope for the worker seat, as `config.path (entry)` */
  reasons: string[];
  /** a resolved alias no deny scope of the staged policy covers */
  uncoveredAlias: boolean;
  covering?: Covering;
};

type Ui = {
  focus: "rail" | "list";
  view: View;
  railAt: number;
  /** -1 = all enabled adapters; otherwise an index into modelGroups */
  adapterAt: number;
  listAt: number;
  filter: string;
  /** explicit search mode — "/" enters, Enter commits (filter stays), Esc cancels */
  searching: boolean;
  /** browser filter stashed while an overlay is up — closing the overlay restores it (OBS-520) */
  stash: { filter: string } | null;
  /** first Esc/q with staged edits arms; the second within the same key sequence quits (OBS-521) */
  quitArmed: boolean;
  showAll: boolean;
  /** v1.92: the FIRST Shapes entry per session auto-raises the presets overlay (both entries) */
  presetsSeen: boolean;
  notice: string;
  /** judge c3: the one entry the last Space press edited, named on that channel's detail line */
  lastEdit: { id: string; text: string } | null;
  /** OBS-1046: channels routing.allow leaves out — a reason of its own, never merged into deny */
  allowOut: Set<string>;
  classifications: FleetClassification[];
  selectedMode: RoutingMode;
  map: Record<string, MapEntry>;
  steering: Record<FleetSteeringKey, string[] | undefined>;
  judgeSeat: string | null;
  channelByAdapter: Record<string, "sub" | "api">;
  overlay: Overlay | null;
  done: boolean;
  // OBS-1099 add.1: one staged set per schema-enumerated deny scope (denyAdapters, denyModels,
  // denyWorkersAdapters, denyWorkersModels, …), keyed exactly as FleetEditable — every scope loop
  // below ranges over DENY_SCOPES, so a scope the schema gains is staged and edited without a hand list.
} & Record<DenyScopeKey, Set<string>>;

export function FleetApp({
  ageMs,
  agents,
  initialAllowOut = [],
  modelGroups,
  initialMode,
  modeOptions,
  initialMap,
  modePreview,
  shapeRows,
  candidatesForShape,
  preferOptionsForShape,
  initialSteering,
  steeringOptionsFor,
  reviewOverlay,
  reloadGuard,
  stagedRouting,
  entry = "probe",
  initialJudge = "",
  judgeSeats = [],
  viewRows = Number.POSITIVE_INFINITY,
  frameColumns = 100,
  frameRows,
  ...initialDenyProps
}: InitialDenyProps & {
  ageMs: number | null;
  agents: AgentCli[];
  /** OBS-1046: adapter ids and adapter:model keys routing.allow leaves out of the fleet */
  initialAllowOut?: string[];
  modelGroups: FleetModelGroup[];
  initialMode: RoutingMode;
  modeOptions: FleetModeOption[];
  initialMap: Record<string, MapEntry>;
  modePreview: (mode: RoutingMode, map: Record<string, MapEntry>, deny: FleetStagedDeny) => string[];
  shapeRows: (mode: RoutingMode, map: Record<string, MapEntry>, deny: FleetStagedDeny) => FleetShapeRow[];
  candidatesForShape: (
    shape: Shape,
    mode: RoutingMode,
    map: Record<string, MapEntry>,
    deny: FleetStagedDeny,
  ) => { rows: FleetCandidateOption[]; excludedNote?: string; ledger?: string[] };
  preferOptionsForShape: (shape: Shape, current: string[]) => string[];
  initialSteering: Record<FleetSteeringKey, string[] | undefined>;
  steeringOptionsFor: (which: FleetSteeringKey, current: string[]) => string[];
  reviewOverlay: (state: FleetEditorState) => FleetOverlayReview;
  reloadGuard: (bytes: string) => string | null;
  /** the routing policy the staged deny sets load as (fleet: the config loader over the candidate
   * bytes); absent ⇒ the four staged sets alone, with no allowlist */
  stagedRouting?: (deny: FleetStagedDeny) => FleetStagedRouting;
  // "presets" is init's entry point: the browser still opens on the models view (fleet scoping
  // first), but Esc is HOME to the routing-preset overlay instead of quit; Enter on a preset
  // there goes straight to the review diff, custom closes back into the browser.
  entry?: "presets" | "probe";
  /** resolved config judge as "adapter:model" — shown on the (keep default) picker row */
  initialJudge?: string;
  /** discovered adapter:model seats — the judge picker universe */
  judgeSeats?: string[];
  /** list viewport capacity (terminal rows minus chrome) — long lists window around the cursor */
  viewRows?: number;
  /** terminal width the frame lays out against */
  frameColumns?: number;
  /** terminal height — set only on a real TTY so the footer sticks to the bottom */
  frameRows?: number;
}) {
  const { exit } = useApp();
  const [, setRevision] = useState(0);
  // the props are the fleet command's contract, one per schema-enumerated scope (initialDeny…),
  // read by a loop so a scope the schema gains seeds its set without a hand field (OBS-1099 add.1)
  const initialDeny = Object.fromEntries(
    DENY_SCOPES.map((scope) => [scope.key, initialDenyProps[initialDenyPropOf(scope)] ?? []]),
  ) as Record<DenyScopeKey, string[]>;
  const uiRef = useRef<Ui | null>(null);
  uiRef.current ??= {
    focus: "list",
    view: "models",
    railAt: 0,
    adapterAt: -1,
    listAt: 0,
    filter: "",
    searching: false,
    stash: null,
    quitArmed: false,
    showAll: false,
    presetsSeen: false,
    notice: "",
    lastEdit: null,
    allowOut: new Set(initialAllowOut),
    ...(Object.fromEntries(DENY_SCOPES.map((scope) => [scope.key, new Set(initialDeny[scope.key])])) as Record<DenyScopeKey, Set<string>>),
    classifications: [],
    selectedMode: initialMode,
    map: structuredClone(initialMap),
    steering: structuredClone(initialSteering),
    judgeSeat: null,
    channelByAdapter: {},
    // v1.92: no entry opens an overlay at launch — the browser opens on the models view (fleet
    // scoping first); the presets overlay raises on the first Shapes entry instead (below).
    overlay: null,
    done: false,
  };
  const ui = uiRef.current;
  const bump = () => setRevision((revision) => revision + 1);

  // OBS-521/OBS-522: one truth for "is there staged work" — the Esc/q loss guard, the header
  // chip, and the empty-`w` notice all read it. Counts staged EDITS, not diff hunks.
  const initialAllowOutSet = new Set(initialAllowOut);
  const stagedCount = (): number => {
    let n = ui.classifications.length
      + (ui.selectedMode !== initialMode ? 1 : 0)
      + (ui.judgeSeat !== null ? 1 : 0);
    for (const scope of DENY_SCOPES) {
      const before = new Set(initialDeny[scope.key]);
      for (const entry of ui[scope.key]) if (!before.has(entry)) n += 1;
      for (const entry of before) if (!ui[scope.key].has(entry)) n += 1;
    }
    for (const key of initialAllowOutSet) if (!ui.allowOut.has(key)) n += 1;
    for (const shape of new Set([...Object.keys(initialMap), ...Object.keys(ui.map)])) {
      // {} ≡ absent: pin-then-auto leaves an empty entry that writes nothing — not staged work
      if (JSON.stringify(initialMap[shape] ?? {}) !== JSON.stringify(ui.map[shape] ?? {})) n += 1;
    }
    for (const key of STEERING_KEYS) {
      if (JSON.stringify(ui.steering[key]) !== JSON.stringify(initialSteering[key])) n += 1;
    }
    return n;
  };

  // ── derived data ───────────────────────────────────────────────────────────

  // OBS-994/FL-1 repair: a flatly (or workers-) denied adapter's channels stay VISIBLE here —
  // every channel needs a reach cell, and Space below can only cycle a scope it can see.
  const enabledGroups = () => modelGroups;
  const scopedGroups = (): FleetModelGroup[] => {
    if (ui.adapterAt === -1) return enabledGroups();
    const group = modelGroups[ui.adapterAt];
    return group ? [group] : [];
  };

  // LEG2-T3 finding 1: a channel's reach and every reason come from the exclusion collector over
  // the STAGED policy (fleet loads the candidate bytes; see stagedRouting) and the recorded
  // identity — never literal membership of the staged sets, which missed identity, bare-model and
  // family entries and could not tell an allowlist exclusion from a deny.
  let routingMemo: { key: string; policy: FleetStagedRouting } | null = null;
  const stagedPolicy = (): FleetStagedRouting => {
    const deny = stagedDeny();
    const key = JSON.stringify(deny);
    if (routingMemo?.key !== key) {
      routingMemo = {
        key,
        policy: stagedRouting
          ? stagedRouting(deny)
          : { ok: true, routing: { deny: denyBlockFrom(denyLists()) } as TickmarkrConfig["routing"] },
      };
    }
    return routingMemo.policy;
  };
  // OBS-1099 add.1: the browser's deny discovery ranges over the schema-enumerated scopes (the
  // route collector names its four paths by hand, so a scope the schema gains would never render
  // or lift here). A flat scope reaches every seat; a nested one only the seat its block names
  // (workers → worker). The allow exclusion (by absence, never lifted) stays the collector's.
  const scopeReaches = (scope: DenyScope, role: PreferenceRole) => scope.path.length === 3 || scope.path[2] === `${role}s`;
  const exclusionsOf = (channel: SeatChannel, routing: TickmarkrConfig["routing"], role: PreferenceRole): ExclusionScope[] => [
    ...DENY_SCOPES.filter((scope) => scopeReaches(scope, role)).flatMap((scope) =>
      (denyEntriesAt(routing, scope) ?? []).filter((entry) => entryMatchesChannel(entry, channel, true))
        .map((entry) => ({ scope: scope.dotted, path: scope.dotted, configPath: scope.dotted, entry, by: "deny" as const }))),
    ...exclusionCollector(channel, routing, role).filter((found) => found.by === "allow"),
  ];
  const reachFor = (adapter: string, model: string, identity?: string): Pick<ModelRow, "reach" | "reasons" | "uncoveredAlias"> => {
    const policy = stagedPolicy();
    if (!policy.ok) return { reach: "unknown", reasons: [`preview unavailable (${policy.error})`], uncoveredAlias: false };
    const channel = { adapter, model, ...(identity !== undefined ? { identity } : {}) };
    const worker = exclusionsOf(channel, policy.routing, "worker");
    const allSeats = exclusionsOf(channel, policy.routing, "judge");
    const reach: FleetReach = allSeats.some((scope) => scope.by === "deny") ? "out-all"
      : allSeats.length ? "out-allow"
      : worker.length ? "out-workers"
      : "in";
    return {
      reach,
      reasons: worker.map(exclusionReason),
      uncoveredAlias: identity !== undefined && !worker.some((scope) => scope.by === "deny"),
    };
  };

  // OBS-1099 review: a displayed row may fold several discovered gateway ids (foldedModels);
  // each folded id is a real channel the policy matches on its own, so every one but a row's
  // own id counts as a sibling — an entry covering a folded id is shared, never row-owned
  const displayedChannels = (): SeatChannel[] => modelGroups.flatMap((group) => group.rows
    .flatMap((other) => (other.foldedModels?.length ? other.foldedModels : [other.model])
      .map((model) => ({ adapter: group.adapter, model, identity: other.evidence?.identity }))));
  const siblingsOf = (self: SeatChannel) => displayedChannels()
    .filter((other) => other.adapter !== self.adapter || other.model !== self.model);
  // Judge c3 (R107): exactly ONE selected entry per act — the channel's adapter:model key when it
  // is a candidate, else the first candidate in sorted order; only an entry no sibling matches
  const selectOwn = (entries: Set<string>, self: SeatChannel): string | undefined => {
    const others = siblingsOf(self);
    const candidates = [...entries].filter((entry) => entryMatchesChannel(entry, self, true)
      && !others.some((other) => entryMatchesChannel(entry, other, true)));
    const id = `${self.adapter}:${self.model}`;
    return candidates.includes(id) ? id : candidates.sort()[0];
  };
  // OBS-1099 add.1: the scope order every row edit ranks by — shallow scopes first, the models
  // list before its adapters sibling (the row-edit order every prior round used) — derived from
  // the schema enumeration, never listed by hand
  const SCOPED = [...DENY_SCOPES].sort((a, b) => a.path.length - b.path.length
    || Number(b.path[b.path.length - 1] === "models") - Number(a.path[a.path.length - 1] === "models"));
  const scopeOf = (dotted: string): DenyScope | undefined => DENY_SCOPES.find((scope) => scope.dotted === dotted);
  const denySets = () => SCOPED.map((scope) => [ui[scope.key], scope.dotted] as const);
  // D-233: adapter-wideness is a property of the ENTRY's grammar (a bare adapter id), never of
  // the config PATH — both .adapters lists accept adapter, model and adapter:model entries alike
  const isAdapterWide = (entry: string, self: SeatChannel) => !entry.includes(":") && entry === self.adapter;
  /** the one row-owned deny entry a picker lift may take — never an allow exclusion, and never an
   * adapter-wide entry (review round 2: an adapter with one displayed channel would otherwise
   * count as owning its whole adapter entry) */
  const ownDeny = (self: SeatChannel): { entry: string; scope: string } | undefined => {
    for (const [set, scope] of denySets()) {
      const entry = selectOwn(new Set([...set].filter((e) => !isAdapterWide(e, self))), self);
      if (entry !== undefined) return { entry, scope };
    }
    return undefined;
  };
  const liftEntry = ({ entry, scope }: { entry: string; scope: string }) => {
    const found = scopeOf(scope);
    if (found) ui[found.key] = new Set([...ui[found.key]].filter((staged) => staged !== entry));
  };
  // Review round 10: the ONE ordered selector both the detail line and the reach edit read — every
  // deny entry this row owns alone (never adapter-wide, never one a displayed sibling matches),
  // the row's own key first (judge c3), then scope order models → adapters → workers.models →
  // workers.adapters, alphabetical within a scope (the row-edit order every prior round used).
  const SCOPE_ORDER = SCOPED.map((scope) => scope.dotted);
  // Read over the RAW staged sets, never the validated policy: the writer restates a flat deny
  // in the allow form, and a row must still find the entry it authored a press ago.
  const ownedDenies = (self: SeatChannel): Array<{ entry: string; scope: string }> => {
    const own = `${self.adapter}:${self.model}`;
    const others = siblingsOf(self);
    const routing = { deny: denyBlockFrom(denyLists()) } as TickmarkrConfig["routing"];
    return exclusionsOf(self, routing, "worker")
      .filter((found) => found.by === "deny" && !isAdapterWide(found.entry, self)
        && !others.some((other) => entryMatchesChannel(found.entry, other, true)))
      .map((found) => ({ entry: found.entry, scope: found.configPath }))
      .sort((a, b) => Number(b.entry === own) - Number(a.entry === own)
        || SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.entry.localeCompare(b.entry));
  };
  // a nested scope (routing.deny.workers.*) denies workers only; a flat one denies every seat
  const WORKERS_SCOPES = SCOPED.filter((scope) => scope.path.length > 3).map((scope) => scope.dotted);
  const FLAT_SCOPES = SCOPED.filter((scope) => scope.path.length === 3).map((scope) => scope.dotted);
  // the adapter rail edits only the `adapters` leaves — its own adapter-id entries (D-233 grammar)
  const FLAT_ADAPTER_SCOPES = SCOPED.filter((scope) => scope.path.length === 3 && scope.path[scope.path.length - 1] === "adapters");
  const NESTED_ADAPTER_SCOPES = SCOPED.filter((scope) => scope.path.length > 3 && scope.path[scope.path.length - 1] === "adapters");
  // review round 12: per reach choice, the entry the Space handler edits — in clears the head,
  // out · workers demotes the first flat entry, out · all promotes the first workers entry
  const reachEdits = (owned: Owned[]): ReachEdits => ({
    clear: owned[0],
    demote: owned.find((f) => FLAT_SCOPES.includes(f.scope)),
    promote: owned.find((f) => WORKERS_SCOPES.includes(f.scope)),
  });
  // OBS-1099 item 2: the entry that covers a row OTHER than its own key (an explicit id reached
  // through the doctor-recorded identity, a bare model, an adapter-wide entry) — named, with every
  // displayed channel it covers. ponytail: O(rows²) over a fleet of dozens; index if it grows.
  const coveringFor = (self: SeatChannel): Covering | undefined => {
    const policy = stagedPolicy();
    if (!policy.ok) return undefined;
    // review round 3: the row's own key is dropped only when it covers no displayed sibling —
    // an explicit id whose alias folds into this row is one shared entry, so it stays here
    // (Space already refuses it as shared) and the l control owns it
    const own = `${self.adapter}:${self.model}`;
    const ownShared = siblingsOf(self).some((other) => entryMatchesChannel(own, other, true));
    // D-245 (review round 11): the named entry is the FIRST ownedDenies record other than the own
    // key (or the own key itself when shared) — the very record Space edits, scope included, never
    // re-ranked through the collector; only a row that owns nothing falls back to the collector's
    // shared entries, adapter-wide last
    const owned = ownedDenies(self);
    const ownedPick = owned.find((f) => f.entry !== own || ownShared);
    const scope = ownedPick ? { entry: ownedPick.entry, configPath: ownedPick.scope }
      : exclusionsOf(self, policy.routing, "worker")
        .filter((found) => found.by === "deny" && (found.entry !== own || ownShared))
        .sort((a, b) => Number(isAdapterWide(a.entry, self)) - Number(isAdapterWide(b.entry, self)))[0];
    if (!scope) return undefined;
    const covers = displayedChannels().filter((channel) => entryMatchesChannel(scope.entry, channel, true))
      .map((channel) => `${channel.adapter}:${channel.model}${channel.identity ? ` (${channel.identity})` : ""}`);
    const shared = isAdapterWide(scope.entry, self) || covers.length > 1;
    return { entry: scope.entry, scope: scope.configPath, covers, shared, edits: reachEdits(owned) };
  };

  const groupRows = (group: FleetModelGroup): ModelRow[] => {
    const rows: ModelRow[] = group.rows.map((row) => {
      const staged = ui.classifications.find(
        (classification) => classification.adapter === group.adapter
          && (classification.model === row.model || classification.model === row.classifyModel),
      );
      const reach = reachFor(group.adapter, row.model, row.evidence?.identity);
      return {
        adapter: group.adapter,
        model: row.model,
        tier: staged?.tier ?? row.tier,
        detectedAt: row.detectedAt,
        suggestion: row.suggestion,
        evidence: row.evidence,
        channel: group.channel,
        classifyModel: row.classifyModel,
        variants: row.variants,
        foldedModels: row.foldedModels,
        score: row.score,
        denied: reach.reach !== "in",
        ...reach,
        // OBS-1099 item 2 (review round 2): every row is covered the same way — an alias through
        // its identity, a plain row by a bare-model or adapter entry — so a shared bare-model
        // entry across adapters has the one owning control too
        covering: coveringFor({ adapter: group.adapter, model: row.model, identity: row.evidence?.identity }),
      };
    });
    const known = new Set(rows.flatMap((row) => row.classifyModel ? [row.model, row.classifyModel] : [row.model]));
    for (const staged of ui.classifications) {
      if (staged.adapter === group.adapter && !known.has(staged.model)) {
        const reach = reachFor(group.adapter, staged.model);
        rows.push({
          adapter: group.adapter,
          model: staged.model,
          tier: staged.tier,
          channel: group.channel,
          denied: reach.reach !== "in",
          ...reach,
        });
      }
    }
    return rows;
  };

  const matches = (label: string, f: string) => f === "" || label.toLowerCase().includes(f.toLowerCase());

  // Operator directive 2026-08-13: retired shapes (dated snapshots, previews, non-worker SKUs,
  // legacy families) hide by DEFAULT. `a` reveals them; a CLASSIFIED row is never hidden.
  const modelRows = (f = ui.filter): ModelRow[] => {
    const rows = scopedGroups().flatMap(groupRows).filter((row) =>
      matches(`${row.adapter}/${row.model} ${(row.foldedModels ?? []).join(" ")}`, f)
      && (ui.showAll || row.tier !== undefined || retiredModelReason(row.model) === null));
    const classified = rows.filter((row) => row.tier !== undefined);
    const unclassified = rows.filter((row) => row.tier === undefined).sort((a, b) =>
      Number(!!b.suggestion) - Number(!!a.suggestion)
        || (b.detectedAt ?? "").localeCompare(a.detectedAt ?? "")
        || (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY)
        || `${a.adapter}/${a.model}`.localeCompare(`${b.adapter}/${b.model}`));
    return [...classified, ...unclassified];
  };
  const hiddenModelCount = (f = ui.filter) =>
    scopedGroups().flatMap(groupRows)
      .filter((row) => matches(`${row.adapter}/${row.model} ${(row.foldedModels ?? []).join(" ")}`, f)).length
    - modelRows(f).length;
  const foldedModelCount = (f = ui.filter) => modelRows(f)
    .reduce((count, row) => count + Math.max((row.foldedModels?.length ?? 1) - 1, 0), 0);

  /** rail counts mirror the list's retired-hide (never the text filter) so numbers agree on screen */
  const visibleCount = (scope: number) => {
    const groups = scope === -1 ? enabledGroups() : (modelGroups[scope] ? [modelGroups[scope]] : []);
    return groups.flatMap(groupRows)
      .filter((row) => ui.showAll || row.tier !== undefined || retiredModelReason(row.model) === null).length;
  };

  // three preview callbacks share it in lockstep — the staged deny truth every preview ranks under.
  // LEG2-T3 finding 2: all four scopes travel distinct; the preview loads them as written.
  const denyLists = (): Record<DenyScopeKey, string[]> =>
    Object.fromEntries(DENY_SCOPES.map((scope) => [scope.key, [...ui[scope.key]].sort()])) as Record<DenyScopeKey, string[]>;
  const stagedDeny = (): FleetStagedDeny => ({
    ...(Object.fromEntries(DENY_SCOPES.map((scope) => [stagedDenyKeyOf(scope), [...ui[scope.key]].sort()])) as Record<StagedDenyKey, string[]>),
    allowOut: [...ui.allowOut].sort(),
  });
  const shapeList = () => shapeRows(ui.selectedMode, ui.map, stagedDeny());
  const steeringList = () => [
    ...STEERING_KEYS.map((key) => ({
      id: key as string,
      label: `${key}.prefer  →  ${ui.steering[key]?.join(", ") ?? "(none)"}`,
    })),
    { id: "judge", label: `judge  →  ${ui.judgeSeat ?? (initialJudge ? `${initialJudge} (default)` : "(default)")}` },
  ];

  const judgeKeepRow = initialJudge ? `(keep default)  ${initialJudge}` : "(keep default)";

  const listLength = () => {
    if (ui.view === "models") return modelRows().length;
    if (ui.view === "shapes") return shapeList().length;
    return steeringList().length;
  };

  const railRows = (): RailRow[] => [
    { kind: "view", view: "models", label: "All models", count: visibleCount(-1) },
    { kind: "view", view: "shapes", label: "Shapes", count: shapeList().length },
    { kind: "view", view: "steering", label: "Steering", count: STEERING_KEYS.length + 1 },
    ...modelGroups.map((_, index): RailRow => ({ kind: "adapter", index })),
  ];

  // ── state transitions ──────────────────────────────────────────────────────

  const editorState = (): FleetEditorState => ({
    ...denyLists(),
    allowOut: [...ui.allowOut].sort(),
    classifications: ui.classifications.map((classification) =>
      classification.vendor && classification.channel
        ? {
          ...classification,
          note: fleetFirstTouchProvenance(classification.note, {
            vendor: classification.vendor,
            channel: classification.channel,
          }),
        }
        : classification),
    selectedMode: ui.selectedMode,
    map: ui.map,
    ...(ui.judgeSeat ? { judgeSeat: splitSeat(ui.judgeSeat) } : {}),
    steering: structuredClone(ui.steering),
  });

  const finish = (result: FleetEditorResult) => {
    if (ui.done) return;
    ui.done = true;
    exit(result);
  };

  const setOverlay = (overlay: Overlay | null) => {
    // OBS-520: an overlay borrows ui.filter for its own search box — stash the browser's committed
    // filter on open and restore it on close, so finishing an assignment/classification does not
    // dump the operator back at the top of an unfiltered list.
    if (ui.overlay === null && overlay !== null) ui.stash = { filter: ui.filter };
    ui.overlay = overlay;
    if (overlay === null) {
      ui.filter = ui.stash?.filter ?? "";
      ui.stash = null;
    } else {
      ui.filter = "";
    }
    ui.searching = false;
    ui.notice = "";
    bump();
  };

  // The one review funnel: an empty staged overlay finishes as no-changes, a real diff shows the
  // confirm overlay. Reached from `w` and, in preset entry, from a preset pick.
  const goReview = () => {
    const nextReview = reviewOverlay(editorState());
    if (nextReview.kind === "empty") {
      finish({ kind: "no-changes" });
      return;
    }
    setOverlay({ kind: "review", review: nextReview, scroll: 0 });
  };

  const stageSuggested = (
    adapter: string,
    rows: Array<{ model: string; suggestion: FleetModelSuggestion }>,
    firstTouch?: { vendor: string; channel: "sub" | "api" },
  ) => {
    ui.classifications = [
      ...ui.classifications,
      ...rows.map((row) => ({
        adapter,
        model: row.model,
        tier: row.suggestion.tier,
        note: row.suggestion.note,
        ...firstTouch,
      })),
    ];
    ui.notice = `staged ${rows.length} catalog-suggested classification(s) — nothing writes before the review diff`;
    bump();
  };

  const groupOf = (adapter: string) => modelGroups.find((group) => group.adapter === adapter);

  const beginClassification = (adapter: string, model: string) => {
    const group = groupOf(adapter);
    if (!group) return;
    // OBS-508: catalog evidence prefills the flow — the tier cursor lands on the suggested band and
    // (when the operator keeps that band) the provenance note arrives pre-typed. Free to override.
    const source = group.rows.find((row) => row.model === model);
    const suggestion = source?.suggestion ?? null;
    const classifyModel = source?.classifyModel ?? model;
    const tierAt = suggestion ? Math.max(TIERS.indexOf(suggestion.tier), 0) : 0;
    const firstTouch = !group.rows.some((row) => row.tier !== undefined)
      && !ui.classifications.some((c) => c.adapter === adapter);
    const base = {
      kind: "classify" as const,
      adapter,
      model: classifyModel,
      ...(classifyModel !== model ? { displayModel: model } : {}),
      channelAt: 0,
      tierAt,
      note: "",
      suggestion,
    };
    if (!firstTouch) {
      setOverlay({ ...base, stage: "tier" });
      return;
    }
    if (!group.vendor) {
      ui.notice = `${adapter} has no vendor declaration — classification cannot be saved`;
      bump();
      return;
    }
    const answered = ui.channelByAdapter[adapter];
    if (answered) {
      setOverlay({ ...base, stage: "tier", vendor: group.vendor });
      return;
    }
    setOverlay({ ...base, stage: "channel", vendor: group.vendor });
  };

  const applyClassification = (overlay: Extract<Overlay, { kind: "classify" }>) => {
    const answered = overlay.vendor ? ui.channelByAdapter[overlay.adapter] : undefined;
    ui.classifications = [
      ...ui.classifications,
      {
        adapter: overlay.adapter,
        model: overlay.model,
        tier: TIERS[overlay.tierAt],
        note: overlay.note.trim(),
        ...(overlay.vendor && answered ? { vendor: overlay.vendor, channel: answered } : {}),
      },
    ];
    setOverlay(null);
  };

  const clampList = () => {
    ui.listAt = Math.min(ui.listAt, Math.max(listLength() - 1, 0));
  };

  // ── sizing (shared by the input handler and the render below) ──────────────

  const width = Math.max(72, Math.min(frameColumns, 160));
  const RAIL_W = 24;
  const bodyW = width - RAIL_W - 5; // borders + padding
  // OBS-523: reserve what the chrome actually uses — header 1, outer borders 2, padding 1,
  // scope+search 2, elision marks 2, detail lines ≤2, keybar 1 — not 16. Six list rows were
  // blank at every terminal size.
  const capacity = Number.isFinite(viewRows) ? Math.max(4, viewRows as number) : Number.POSITIVE_INFINITY;
  /** review diff rows: overlay chrome is one row shorter than the browser's (no scope header) */
  const reviewCapacity = () => Number.isFinite(capacity) ? Math.min(Math.max(capacity + 1, 4), 400) : 400;
  // OBS-1099 item 4 (D-199, D-205): an adapter row's reach and remaining reasons come from the
  // exclusion collector over the STAGED policy for EVERY channel it serves — displayed rows and the
  // gateway ids folded into them — never literal set membership, which misses model-scope entries
  // that cover the whole adapter (a bare adapter id in routing.deny.models: preference.ts).
  // D-205: reach is the MOST-excluded channel's reach — in only when every channel is in, out-all
  // when any channel is out for all seats, else out-workers — and `partial` says the channels
  // disagree, so a mixed rail is never shown or guarded as an adapter-wide selected state.
  // Reasons are the UNION over the channels: one every channel shares is named once, a
  // channel-specific one carries its channel, so a partial exclusion is never intersected away.
  const adapterReach = (id: string): { reach: FleetReach; reasons: string[]; partial: boolean } => {
    const group = modelGroups.find((candidate) => candidate.adapter === id);
    const channels = (group?.rows ?? []).flatMap((row) => (row.foldedModels?.length ? row.foldedModels : [row.model])
      .map((model) => ({ model, ...reachFor(id, model, row.evidence?.identity) })));
    if (channels.length === 0) {
      // ponytail: a rail entry with no probed channels has only its own literal entries to show
      const reasons = [
        ...FLAT_ADAPTER_SCOPES.filter((scope) => ui[scope.key].has(id)).map((scope) => `${scope.dotted} (${id})`),
        ui.allowOut.has(id) ? "routing.allow (not admitted)" : "",
        ...NESTED_ADAPTER_SCOPES.filter((scope) => ui[scope.key].has(id)).map((scope) => `${scope.dotted} (${id})`),
      ].filter(Boolean);
      const reach: FleetReach = FLAT_ADAPTER_SCOPES.some((scope) => ui[scope.key].has(id)) ? "out-all"
        : ui.allowOut.has(id) ? "out-allow"
        : NESTED_ADAPTER_SCOPES.some((scope) => ui[scope.key].has(id)) ? "out-workers" : "in";
      return { reach, reasons, partial: false };
    }
    const unknown = channels.find((channel) => channel.reach === "unknown");
    if (unknown) return { reach: "unknown", reasons: unknown.reasons, partial: false };
    // OBS-1099 review round 5: out-allow and out-all are ONE picker choice (out · all seats), so a
    // deny-excluded channel beside an allow-excluded one is uniformly out-all, never partial
    const picked = (reach: FleetReach): FleetReach => reach === "out-allow" ? "out-all" : reach;
    const rank: Record<FleetReach, number> = { unknown: -1, in: 0, "out-workers": 1, "out-allow": 2, "out-all": 2 };
    const reach = channels.reduce<FleetReach>((most, channel) => rank[channel.reach] > rank[most] ? picked(channel.reach) : most, picked(channels[0].reach));
    const partial = channels.some((channel) => picked(channel.reach) !== reach);
    const shared = channels[0].reasons.filter((reason) => channels.every((channel) => channel.reasons.includes(reason)));
    const own = channels.flatMap((channel) => channel.reasons
      .filter((reason) => !shared.includes(reason))
      .map((reason) => `${channel.model}: ${reason}`));
    return { reach, reasons: [...shared, ...own], partial };
  };
  const describeReach = (state: { reach: FleetReach; partial: boolean }) => state.partial ? `${state.reach} (partial: not every channel)` : state.reach;

  // OBS-1099 items 1 and 4: one picker choice changes exactly ONE selected entry in ONE scope —
  // added, cleared, or re-scoped between the workers list and the flat list — then the row's
  // ACTUAL reach is recomputed and the remaining reasons named. The one-entry-per-press law
  // (R107, LEG2-T3) stays: a shared or adapter-wide entry covering sibling channels is never
  // edited from a channel row; the refusal names it. A row holding two reasons is never promised
  // in after one act.
  const applyReach = (target: { adapter: string; model?: string }, choice: ReachChoice) => {
    const without = (set: Set<string>, entry: string) => new Set([...set].filter((staged) => staged !== entry));
    const withEntry = (set: Set<string>, entry: string) => new Set([...set, entry]);
    const label = REACH_CHOICES.find((option) => option.id === choice)!.label;
    // the allow form is how the writer spells an all-seats exclusion — it IS out · all seats
    const reached = (reach: FleetReach, wanted: ReachChoice) => reach === wanted || (wanted === "out-all" && reach === "out-allow");

    if (target.model === undefined) {
      const id = target.adapter;
      const { reach, reasons, partial } = adapterReach(id);
      // the rail edits exactly ONE adapter-id entry: the authored deny before the allow complement
      // before the workers deny (OBS-1046). Reach that comes only from channel-scope entries is not
      // the rail's to clear — the refusal names those reasons.
      // OBS-1099 add.1: the held entry is looked up over the schema-enumerated adapter scopes,
      // flat before the allow complement before nested
      const heldScope = FLAT_ADAPTER_SCOPES.find((scope) => ui[scope.key].has(id))
        ?? (ui.allowOut.has(id) ? undefined : NESTED_ADAPTER_SCOPES.find((scope) => ui[scope.key].has(id)));
      const held = heldScope?.dotted ?? (ui.allowOut.has(id) ? "routing.allow" : null);
      const take = () => {
        if (heldScope) ui[heldScope.key] = without(ui[heldScope.key], id);
        else ui.allowOut = without(ui.allowOut, id);
      };
      let edit = "";
      // OBS-1099 review: transitions are judged on ACTUAL reach, not only on the held entry — an
      // adapter that is out only through channel-scope entries (a bare adapter id in
      // routing.deny.models) has nothing the rail may move: a choice it already reaches says so,
      // and a choice that would leave it out-all while staging a second reason is refused by name.
      // D-205: a PARTIAL rail (channels disagree) is never "already" anything — the choice that
      // widens every channel to the picked reach is one act, the others are refused by name
      if (held === null && !partial && reached(reach, choice)) {
        ui.notice = `${id} is already ${label}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`;
        return;
      }
      if (held === null && (choice === "in" || (choice === "out-workers" && reached(reach, "out-all")))) {
        ui.notice = `${id} stays ${describeReach({ reach, partial })} — ${reasons.join("; ")} — the rail edits only ${id}'s own adapter entries; set reach on the channel rows`;
        return;
      }
      if (choice === "in") {
        take();
        edit = `cleared ${id} from ${held}`;
      } else if (choice === "out-workers") {
        if (held === "routing.deny.workers.adapters") {
          // OBS-1099 review round 3: the held workers entry is already the rail's whole say —
          // when actual reach is still out-all, the remaining all-seat reasons live on the
          // channel rows, and this choice cannot reach workers-only until they clear
          if (!partial && reached(reach, choice)) {
            ui.notice = `${id} is already ${label}`;
          } else {
            const remaining = reasons.filter((reason) => reason !== `routing.deny.workers.adapters (${id})`);
            ui.notice = `${id} stays ${describeReach({ reach, partial })} — ${remaining.join("; ")} — ${id} is already in routing.deny.workers.adapters; workers-only reach needs those all-seat reasons cleared on the channel rows`;
          }
          return;
        }
        if (held !== null) take();
        ui.denyWorkersAdapters = withEntry(ui.denyWorkersAdapters, id);
        edit = `${held === null ? "added" : "moved"} ${id} to routing.deny.workers.adapters`;
      } else {
        if (held === "routing.deny.adapters" || held === "routing.allow") {
          ui.notice = `${id} is already ${label}`;
          return;
        }
        if (held !== null) take();
        ui.denyAdapters = withEntry(ui.denyAdapters, id);
        edit = `${held === null ? "added" : "moved"} ${id} to routing.deny.adapters`;
      }
      const after = adapterReach(id);
      // a partially excluded adapter (one channel still out by its own entry) names what remains
      const still = choice === "in" ? after.reasons.length > 0 : after.partial || !reached(after.reach, choice);
      ui.notice = `space: ${edit}${still ? ` — still out: ${after.reasons.join("; ")}` : ""}`;
      clampList();
      return;
    }

    const row = modelRows().find((candidate) => candidate.adapter === target.adapter && candidate.model === target.model);
    if (!row) return;
    const id = `${row.adapter}:${row.model}`;
    const self = { adapter: row.adapter, model: row.model, identity: row.evidence?.identity };
    // LEG2-T3 round 2 finding 1 / D-233 / D-235 (review round 10): ONE ordered selector —
    // ownedDenies — feeds the detail line AND every Space edit, so the entry named is the entry
    // edited: a clear takes its head (own key first, then collector order); a demotion takes its
    // first flat entry, a promotion its first workers entry; a bare adapter id or a sibling's
    // entry is never in it. OBS-1046: an allow exclusion is the LAST reason taken, never together
    // with an authored deny.
    const edits = reachEdits(ownedDenies(self));
    const ownAllow = (): Owned | undefined => {
      const fromAllow = selectOwn(ui.allowOut, self);
      return fromAllow === undefined ? undefined : { entry: fromAllow, scope: "routing.allow" };
    };
    const ownFlat = () => edits.demote ?? ownAllow();
    const ownWorkers = () => edits.promote;
    const takeFlat = (found: { entry: string; scope: string }) => {
      const scope = scopeOf(found.scope);
      if (scope) ui[scope.key] = without(ui[scope.key], found.entry);
      else ui.allowOut = without(ui.allowOut, found.entry);
    };
    const refuse = (reachLabel: string) => {
      // OBS-1099 item 2: a covered row names the covering entry, every identity it covers, and
      // the ONE control that lifts it — the T1 refusal wording stays in front of it
      if (row.covering?.shared) {
        // the notice clips at the browser width; the detail line and the l overlay list every identity
        ui.notice = `${id} stays ${reachLabel} — ${row.covering.scope} (${row.covering.entry}) covers ${row.covering.covers.length} channels — Space edits only this channel's own entries; l lists and lifts it`;
        return;
      }
      const shared = ui.denyAdapters.has(row.adapter) || ui.allowOut.has(row.adapter) || ui.denyWorkersAdapters.has(row.adapter)
        ? `every ${row.adapter} channel is out together — set the adapter's reach on the rail`
        : "a shared entry covers other channels too";
      ui.notice = `${id} stays ${reachLabel} — ${row.reasons.join("; ")} — Space edits only this channel's own entries; ${shared}`;
    };

    const reach = row.reach;
    const outAll = reach === "out-all" || reach === "out-allow";
    let edit = "";
    if (choice === "out-workers" && reach === "in") {
      ui.denyWorkersModels = withEntry(ui.denyWorkersModels, id);
      edit = `added ${id} to routing.deny.workers.models`;
    } else if (choice === "out-workers" && outAll) {
      const found = ownFlat();
      if (found === undefined) return refuse("out");
      takeFlat(found);
      ui.denyWorkersModels = withEntry(ui.denyWorkersModels, found.entry);
      edit = `moved ${found.entry} to routing.deny.workers.models`;
    } else if (choice === "out-all" && reach === "in") {
      ui.denyModels = withEntry(ui.denyModels, id);
      edit = `added ${id} to routing.deny.models`;
    } else if (choice === "out-all" && reach === "out-workers") {
      // OBS-1099 review: a promotion, like a clear, takes only an entry no sibling row matches —
      // a shared workers entry (adapter-wide or a bare id another row serves) is refused by name,
      // never moved for its siblings and never doubled by a fresh flat deny
      const found = ownWorkers();
      if (found === undefined) return refuse("out · workers");
      takeFlat(found);
      ui.denyModels = withEntry(ui.denyModels, found.entry);
      edit = `moved ${found.entry} to routing.deny.models`;
    } else if (choice === "in" && reach !== "in") {
      // D-205: in clears ONE row-owned reason from either the flat scopes or the workers scope —
      // a shared flat reason (routing.deny.adapters covering every channel) never blocks clearing
      // this row's own workers entry; the recomputed reach then names the shared reason that remains
      const found = edits.clear ?? (outAll ? ownAllow() : undefined);
      if (found !== undefined) {
        takeFlat(found);
        edit = `cleared ${found.entry} from ${found.scope}`;
      } else {
        return refuse(outAll ? "out" : "out · workers");
      }
    } else {
      ui.notice = `${id} is already ${label}`;
      return;
    }
    const after = reachFor(row.adapter, row.model, row.evidence?.identity);
    const still = reached(after.reach, choice) ? "" : ` — still out: ${after.reasons.join("; ")}`;
    ui.lastEdit = { id, text: `space: ${edit}${still}` };
  };

  // OBS-1065: Enter on a greyed picker row lifts exactly its row-owned covering entry, then the
  // same picker reopens over the recomputed policy — a shared or adapter-wide entry is refused by
  // name and the row stays greyed
  const liftFromPicker = (overlay: CandidatesOverlay, line: string) => {
    const head = line.split(" — ")[0];
    const slash = head.indexOf("/");
    const self = slash === -1 ? undefined
      : displayedChannels().find((channel) => channel.adapter === head.slice(0, slash) && channel.model === head.slice(slash + 1));
    if (!self) {
      ui.notice = `nothing to lift on this row — ${line}`;
      bump();
      return;
    }
    const id = `${self.adapter}:${self.model}`;
    // review round 2/4: only a channel that is otherwise eligible (tier floor, auth, pin/pool) may
    // be lifted. Eligibility is read from the picker source itself, never the ledger strings: the
    // channel must be OFFERED at or above the floor once every policy scope is open — a failed
    // model probe (dropped by discovery), a pin or a pool keep it out of that list and a floor
    // marks it belowFloor, so nothing here lifts it.
    const eligible = candidatesForShape(overlay.shape, ui.selectedMode, ui.map, openStagedDeny()).rows
      .some((row) => row.id === id && !row.belowFloor);
    if (!eligible) {
      // the ledger line spells its reasons; drop the row label and the reach segment for the notice
      const reasons = line.split(" — ").slice(1).filter((segment) => !segment.startsWith("reach: "));
      ui.notice = `${id} stays out — ${reasons.join(" — ")} — nothing here to lift`;
      bump();
      return;
    }
    const found = ownDeny(self);
    if (found === undefined) {
      const covering = coveringFor(self);
      ui.notice = covering
        ? `${id} stays out — ${covering.scope} (${covering.entry}) covers ${covering.covers.join(", ")} — l on its models row lifts that one entry`
        : `${id} stays out — ${reachFor(self.adapter, self.model, self.identity).reasons.join("; ") || "not a deny entry"} — nothing here to lift`;
      bump();
      return;
    }
    liftEntry(found);
    const after = reachFor(self.adapter, self.model, self.identity);
    const text = `lift: cleared ${found.entry} from ${found.scope}${after.reach === "in" ? "" : ` — still out: ${after.reasons.join("; ")}`}`;
    ui.lastEdit = { id, text };
    ui.notice = text;
    const picked = candidatesForShape(overlay.shape, ui.selectedMode, ui.map, stagedDeny());
    ui.overlay = { ...overlay, rows: picked.rows, excludedNote: picked.excludedNote, ledger: picked.ledger ?? [], at: 0 };
    bump();
  };

  const reviewWindow = (overlay: Extract<Overlay, { kind: "review" }>) => {
    const lines = overlay.review.diff.split("\n");
    const cap = reviewCapacity();
    const maxScroll = Math.max(lines.length - cap, 0);
    const scroll = Math.min(Math.max(overlay.scroll, 0), maxScroll);
    return { lines, cap, maxScroll, scroll, visible: lines.slice(scroll, scroll + cap) };
  };

  // OBS-521: quitting with staged edits needs a second Esc/q — armed by the first press,
  // disarmed by any other key. Ctrl+C stays an immediate exit.
  const guardedQuit = (armed: boolean): boolean => {
    const staged = stagedCount();
    if (staged === 0 || armed) {
      finish({ kind: "quit" });
      return true;
    }
    ui.quitArmed = true;
    ui.notice = `${staged} staged edit(s) not written — w reviews the diff · press again to discard and quit`;
    bump();
    return false;
  };

  // ── input ──────────────────────────────────────────────────────────────────

  useInput((input, key) => {
    if (ui.done) return;
    if (key.ctrl && input === "c") {
      finish({ kind: "quit" });
      return;
    }
    const armed = ui.quitArmed;
    ui.quitArmed = false;

    const overlay = ui.overlay;
    // Search is an EXPLICIT, visible mode: "/" enters it, Enter commits (filter stays applied),
    // Esc cancels. While it is on, every printable char belongs to the search box so "kimi" or
    // "fake-n" can actually be typed; outside it letters are ALWAYS commands — even with a
    // committed filter applied. The old implicit rule (hotkeys dormant whenever the filter was
    // non-empty) confused both directions in the field: the first letter of a query fired
    // commands, and a live filter silently ate m/w/j/k. (operator field sessions, 2026-08-13
    // and 2026-08-15)
    const hotkey = ui.searching ? "" : input;

    // filter editing shared by the searchable surfaces
    const editFilter = (count: (f: string) => number, clampAt?: (max: number) => void): boolean => {
      // a LEADING "/" is the browser's search affordance, not query text — swallow it so the
      // muscle memory "/kimi" works in every searchable overlay too (no channel id starts with /).
      // A real terminal may deliver fast typing or a paste as ONE keypress chunk ("/kimi"), so the
      // strip handles the chunk form as well as the lone key. A pasted chunk may also carry a
      // trailing newline ("glm-5.3\r") — control bytes are terminal framing, never query text;
      // left in, they made every row "not match" until the operator retyped the query by hand.
      const chunk = ui.filter === "" && input.startsWith("/") ? input.slice(1) : input;
      const typed = chunk.replace(/[\u0000-\u001f\u007f]/g, "");
      if (typed === "" && input.startsWith("/")) return true;
      const printable = typed > " " && !key.ctrl && !key.meta;
      const next = key.backspace || key.delete
        ? ui.filter.slice(0, -1)
        : (printable ? ui.filter + typed : null);
      if (next === null) return false;
      ui.filter = next;
      // OBS-520: the clamp targets the surface being filtered — an overlay clamps ITS cursor,
      // never the browser's listAt (typing in a picker used to drag the shapes cursor to row 0).
      const max = Math.max(count(next) - 1, 0);
      if (clampAt) clampAt(max);
      else ui.listAt = Math.min(ui.listAt, max);
      ui.notice = "";
      bump();
      return true;
    };

    if (overlay) {
      if (overlay.kind === "presets") {
        const rowCount = modeOptions.length + (overlay.home ? 1 : 0);
        if (key.escape) {
          if (overlay.home) {
            guardedQuit(armed);
            return;
          }
          setOverlay(null);
          return;
        }
        if (hotkey === "q") {
          guardedQuit(armed);
          return;
        }
        if (key.downArrow || hotkey === "j") {
          overlay.at = Math.min(overlay.at + 1, rowCount - 1);
          bump();
          return;
        }
        if (key.upArrow || hotkey === "k") {
          overlay.at = Math.max(overlay.at - 1, 0);
          bump();
          return;
        }
        if (key.return) {
          if (overlay.home && overlay.at === modeOptions.length) {
            setOverlay(null); // custom → the browser IS the full editor
            return;
          }
          const option = modeOptions[overlay.at];
          if (!option) return;
          ui.selectedMode = option.id;
          if (overlay.home) {
            goReview(); // entry context: a preset pick goes straight to the diff confirm
            return;
          }
          setOverlay(null);
        }
        return;
      }

      if (overlay.kind === "review") {
        if (key.escape) {
          // non-destructive: back to the browser with everything still staged
          setOverlay(entry === "presets" ? { kind: "presets", at: 0, home: true } : null);
          return;
        }
        // OBS-524: the operator must be able to READ the whole diff they are approving —
        // ↑↓/jk scroll a line, PgUp/PgDn a window; the elision rows carry the counts.
        const window = reviewWindow(overlay);
        if (key.downArrow || input === "j") {
          overlay.scroll = Math.min(window.scroll + 1, window.maxScroll);
          bump();
          return;
        }
        if (key.upArrow || input === "k") {
          overlay.scroll = Math.max(window.scroll - 1, 0);
          bump();
          return;
        }
        if (key.pageDown) {
          overlay.scroll = Math.min(window.scroll + window.cap, window.maxScroll);
          bump();
          return;
        }
        if (key.pageUp) {
          overlay.scroll = Math.max(window.scroll - window.cap, 0);
          bump();
          return;
        }
        if (input === "n") {
          finish({ kind: "discard" });
          return;
        }
        if (input === "q") {
          finish({ kind: "quit" });
          return;
        }
        if (input === "y") {
          const loadError = reloadGuard(overlay.review.after);
          if (loadError) {
            setOverlay(null);
            ui.notice = `config loader rejects the proposed overlay — ${loadError}`;
            bump();
            return;
          }
          finish({ kind: "write", review: overlay.review });
        }
        return;
      }

      if (overlay.kind === "classify") {
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (overlay.stage === "channel") {
          if (key.downArrow || input === "j") {
            overlay.channelAt = Math.min(overlay.channelAt + 1, CHANNELS.length - 1);
            bump();
            return;
          }
          if (key.upArrow || input === "k") {
            overlay.channelAt = Math.max(overlay.channelAt - 1, 0);
            bump();
            return;
          }
          if (key.return) {
            const channel = CHANNELS[overlay.channelAt];
            ui.channelByAdapter[overlay.adapter] = channel;
            // OBS-508: a bulk stage waiting on the one first-touch channel answer resumes here.
            if (overlay.bulk) {
              stageSuggested(overlay.bulk.adapter, overlay.bulk.rows, { vendor: overlay.bulk.vendor, channel });
              const notice = ui.notice;
              setOverlay(null);
              ui.notice = notice;
              bump();
              return;
            }
            overlay.stage = "tier";
            bump();
          }
          return;
        }
        if (overlay.stage === "tier") {
          if (key.downArrow || input === "j") {
            overlay.tierAt = Math.min(overlay.tierAt + 1, TIERS.length - 1);
            bump();
            return;
          }
          if (key.upArrow || input === "k") {
            overlay.tierAt = Math.max(overlay.tierAt - 1, 0);
            bump();
            return;
          }
          if (key.return) {
            // OBS-508: keep the suggested band → the evidence note arrives pre-typed; override the
            // band → the note starts empty (the suggestion argues for a DIFFERENT tier).
            const chosen = TIERS[overlay.tierAt];
            overlay.note = overlay.suggestion && overlay.suggestion.tier === chosen ? overlay.suggestion.note : "";
            overlay.stage = "note";
            bump();
          }
          return;
        }
        // note stage — free text
        if (key.return) {
          if (!overlay.note.trim()) {
            ui.notice = "a typed benchmark-provenance note is required";
            bump();
            return;
          }
          applyClassification(overlay);
          return;
        }
        if (key.backspace || key.delete) {
          overlay.note = overlay.note.slice(0, -1);
          bump();
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          overlay.note += input;
          ui.notice = "";
          bump();
        }
        return;
      }

      if (overlay.kind === "add-model") {
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.return) {
          const candidate = overlay.text;
          if (!MODEL_ID_RE.test(candidate)) {
            ui.notice = `model id must match ${MODEL_ID_RE.source}`;
            bump();
            return;
          }
          const group = groupOf(overlay.adapter);
          const exists = group
            && groupRows(group).some((row) => row.model === candidate);
          if (exists) {
            ui.notice = `${candidate} is already listed for ${overlay.adapter}`;
            bump();
            return;
          }
          beginClassification(overlay.adapter, candidate);
          return;
        }
        if (key.backspace || key.delete) {
          overlay.text = overlay.text.slice(0, -1);
          bump();
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          overlay.text += input;
          ui.notice = "";
          bump();
        }
        return;
      }

      if (overlay.kind === "assign") {
        const rows = shapeList();
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.downArrow || input === "j") {
          overlay.at = Math.min(overlay.at + 1, Math.max(rows.length - 1, 0));
          bump();
          return;
        }
        if (key.upArrow || input === "k") {
          overlay.at = Math.max(overlay.at - 1, 0);
          bump();
          return;
        }
        if (key.return && rows[overlay.at]) {
          const shape = rows[overlay.at].id;
          ui.map = { ...ui.map, [shape]: { pin: { via: overlay.adapter, model: overlay.model } } };
          setOverlay(null);
          ui.notice = `pinned ${shape} → ${overlay.adapter}:${overlay.model}`;
          bump();
        }
        return;
      }

      if (overlay.kind === "candidates") {
        const rows = overlay.rows.filter((candidate) => matches(candidate.label, ui.filter));
        const ledger = overlay.ledger.filter((line) => matches(line, ui.filter));
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.downArrow) {
          overlay.at = Math.min(overlay.at + 1, Math.max(rows.length + ledger.length - 1, 0));
          bump();
          return;
        }
        if (key.upArrow) {
          overlay.at = Math.max(overlay.at - 1, 0);
          bump();
          return;
        }
        if (input === " " && rows[overlay.at]) {
          const id = rows[overlay.at].id;
          const at = overlay.chain.indexOf(id);
          if (at === -1) overlay.chain.push(id);
          else overlay.chain.splice(at, 1);
          bump();
          return;
        }
        if (key.return) {
          const greyed = ledger[overlay.at - rows.length];
          if (!rows[overlay.at] && greyed !== undefined) {
            liftFromPicker(overlay, greyed);
            return;
          }
          if (overlay.chain.length) {
            // a selection is a POOL, and its mode is a decision, not a default — the tiny
            // poolmode overlay asks it; Esc there restores this picker with the chain intact
            // OBS-525: an existing pool's mode seeds the cursor so a round-trip keeps it
            setOverlay({ kind: "poolmode", picker: overlay, at: ui.map[overlay.shape]?.pool?.mode === "ordered" ? 1 : 0 });
            return;
          }
          if (rows[overlay.at]) {
            ui.map = { ...ui.map, [overlay.shape]: { pin: rows[overlay.at].pin } };
            setOverlay(null);
            return;
          }
          return;
        }
        editFilter(
          (f) => overlay.rows.filter((candidate) => matches(candidate.label, f)).length
            + overlay.ledger.filter((line) => matches(line, f)).length,
          (max) => {
            overlay.at = Math.min(overlay.at, max);
          },
        );
        return;
      }

      if (overlay.kind === "poolmode") {
        if (key.escape) {
          setOverlay(overlay.picker); // back to the picker — chain and cursor intact
          return;
        }
        if (key.downArrow || input === "j") {
          overlay.at = 1;
          bump();
          return;
        }
        if (key.upArrow || input === "k") {
          overlay.at = 0;
          bump();
          return;
        }
        if (key.return) {
          const { shape, chain } = overlay.picker;
          // a pool is the shape's WHOLE declaration: pin and prefer leave with it (schema
          // exclusivity — pin+pool and pool+prefer both fail config load)
          const { pin: _pin, prefer: _prefer, pool: _pool, ...entry } = ui.map[shape] ?? {};
          ui.map = {
            ...ui.map,
            [shape]: { ...entry, pool: { mode: overlay.at === 0 ? "any" : "ordered", channels: chain.slice() } },
          };
          setOverlay(null);
        }
        return;
      }

      if (overlay.kind === "prefer") {
        const rows = overlay.rows.filter((option) => matches(option, ui.filter));
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.downArrow) {
          overlay.at = Math.min(overlay.at + 1, Math.max(rows.length - 1, 0));
          bump();
          return;
        }
        if (key.upArrow) {
          overlay.at = Math.max(overlay.at - 1, 0);
          bump();
          return;
        }
        if (input === " " && rows[overlay.at]) {
          const option = rows[overlay.at];
          const at = overlay.chain.indexOf(option);
          if (at === -1) overlay.chain.push(option);
          else overlay.chain.splice(at, 1);
          bump();
          return;
        }
        if (key.return) {
          if ("shape" in overlay.target) {
            const shape = overlay.target.shape;
            const nextEntry = { ...ui.map[shape] };
            if (overlay.chain.length) nextEntry.prefer = overlay.chain.slice();
            else delete nextEntry.prefer;
            ui.map = { ...ui.map, [shape]: nextEntry };
          } else {
            ui.steering = {
              ...ui.steering,
              [overlay.target.steering]: overlay.chain.length ? overlay.chain.slice() : undefined,
            };
          }
          setOverlay(null);
          return;
        }
        editFilter(
          (f) => overlay.rows.filter((option) => matches(option, f)).length,
          (max) => {
            overlay.at = Math.min(overlay.at, max);
          },
        );
        return;
      }

      if (overlay.kind === "reach") {
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.downArrow || input === "j") {
          overlay.at = Math.min(overlay.at + 1, REACH_CHOICES.length - 1);
          bump();
          return;
        }
        if (key.upArrow || input === "k") {
          overlay.at = Math.max(overlay.at - 1, 0);
          bump();
          return;
        }
        if (key.return) {
          const choice = REACH_CHOICES[overlay.at].id;
          setOverlay(null);
          applyReach(overlay.target, choice);
          bump();
        }
        return;
      }

      if (overlay.kind === "lift") {
        if (key.escape) {
          setOverlay(null);
          return;
        }
        if (key.return) {
          liftEntry(overlay.covering);
          ui.lastEdit = { id: overlay.id, text: `lift: cleared ${overlay.covering.entry} from ${overlay.covering.scope} (covered ${overlay.covering.covers.join(", ")})` };
          setOverlay(null);
          bump();
        }
        return;
      }

      // judge overlay
      const rows = [judgeKeepRow, ...judgeSeats].filter((row) => matches(row, ui.filter));
      if (key.escape) {
        setOverlay(null);
        return;
      }
      if (key.downArrow) {
        overlay.at = Math.min(overlay.at + 1, Math.max(rows.length - 1, 0));
        bump();
        return;
      }
      if (key.upArrow) {
        overlay.at = Math.max(overlay.at - 1, 0);
        bump();
        return;
      }
      if (key.return && rows[overlay.at]) {
        // single-select: one seat or back to the config default — never a chain
        const picked = rows[overlay.at];
        ui.judgeSeat = picked === judgeKeepRow ? null : picked;
        setOverlay(null);
        return;
      }
      editFilter(
        (f) => [judgeKeepRow, ...judgeSeats].filter((row) => matches(row, f)).length,
        (max) => {
          overlay.at = Math.min(overlay.at, max);
        },
      );
      return;
    }

    // ── browser (no overlay) ─────────────────────────────────────────────────

    if (ui.searching) {
      if (key.escape) {
        ui.searching = false;
        ui.filter = "";
        bump();
        return;
      }
      if (key.return) {
        ui.searching = false;
        bump();
        return;
      }
      if (key.downArrow) {
        ui.listAt = Math.min(ui.listAt + 1, Math.max(listLength() - 1, 0));
        bump();
        return;
      }
      if (key.upArrow) {
        ui.listAt = Math.max(ui.listAt - 1, 0);
        bump();
        return;
      }
      editFilter((f) => modelRows(f).length);
      return;
    }
    if (key.escape) {
      if (ui.filter !== "") {
        ui.filter = "";
        bump();
        return;
      }
      // v1.90.8: inside the init journey one Esc must never discard the whole walk — it returns
      // HOME to the presets overlay; Esc there (or q/ctrl+c anywhere) remains the real quit.
      if (entry === "presets") {
        setOverlay({ kind: "presets", at: Math.max(modeOptions.findIndex((option) => option.id === ui.selectedMode), 0), home: true });
        return;
      }
      guardedQuit(armed);
      return;
    }
    if (hotkey === "q") {
      guardedQuit(armed);
      return;
    }
    if (hotkey === "r") {
      finish({ kind: "refresh" });
      return;
    }
    if (hotkey === "w") {
      // OBS-522: an empty `w` used to EXIT the editor as no-changes — a save key must never
      // double as quit. Say there is nothing to write and stay.
      if (stagedCount() === 0) {
        ui.notice = "no staged edits — nothing to write (Esc quits)";
        bump();
        return;
      }
      goReview();
      return;
    }
    if (hotkey === "m") {
      setOverlay({ kind: "presets", at: Math.max(modeOptions.findIndex((option) => option.id === ui.selectedMode), 0), home: false });
      return;
    }
    if (hotkey === "/" || (hotkey.startsWith("/") && hotkey.length > 1)) {
      if (ui.view !== "models") {
        // the shapes and steering lists are 9/3 fixed rows — nothing to search; say where search
        // lives instead of eating the key silently (operator field report, 2026-08-16)
        ui.notice = "this list is not searchable — / searches the models view (All models or an adapter in the rail)";
        bump();
        return;
      }
      ui.searching = true;
      ui.focus = "list";
      ui.notice = "";
      // fast typing or a paste arrives as one chunk ("/kimi") — the tail is the query; control
      // bytes (a pasted trailing "\r") are framing, not query text
      ui.filter = hotkey.slice(1).replace(/[\u0000-\u001f\u007f]/g, "");
      ui.listAt = Math.min(ui.listAt, Math.max(modelRows(ui.filter).length - 1, 0));
      bump();
      return;
    }

    // focus moves
    if (key.leftArrow || (key.tab && ui.focus === "list")) {
      ui.focus = "rail";
      bump();
      return;
    }
    if (key.rightArrow || (key.tab && ui.focus === "rail")) {
      ui.focus = "list";
      bump();
      return;
    }

    if (ui.focus === "rail") {
      const rows = railRows();
      if (key.downArrow || hotkey === "j") {
        ui.railAt = Math.min(ui.railAt + 1, rows.length - 1);
        bump();
        return;
      }
      if (key.upArrow || hotkey === "k") {
        ui.railAt = Math.max(ui.railAt - 1, 0);
        bump();
        return;
      }
      const row = rows[ui.railAt];
      if (!row) return;
      if (input === " " && row.kind === "adapter") {
        const id = modelGroups[row.index].adapter;
        // membership can't fix auth — say so, or the ✗ reads as a toggle that refuses to move
        // (operator field report, 2026-08-16: expired kimi token)
        const unauthed = agents.find((agent) => agent.id === id)?.authed === false
          ? `${id} is not authed — Space only sets fleet reach; re-auth the ${id} CLI, then run tickmarkr doctor`
          : "";
        // OBS-1099 item 4: an adapter row gets the same three-way reach picker as a model row
        setOverlay({ kind: "reach", target: { adapter: id }, at: 0 });
        ui.notice = unauthed;
        bump();
        return;
      }
      if (key.return) {
        if (row.kind === "view") {
          ui.view = row.view;
          if (row.view === "models") ui.adapterAt = -1;
        } else {
          ui.view = "models";
          ui.adapterAt = row.index;
        }
        ui.focus = "list";
        ui.listAt = 0;
        ui.filter = "";
        ui.notice = "";
        // v1.92: the FIRST Shapes entry per session raises the presets overlay (both entries:
        // fleet and init) — Esc from it lands right here in the shapes list, never quits.
        if (ui.view === "shapes" && !ui.presetsSeen) {
          ui.presetsSeen = true;
          ui.overlay = {
            kind: "presets",
            at: Math.max(modeOptions.findIndex((option) => option.id === ui.selectedMode), 0),
            home: false,
          };
        }
        bump();
      }
      return;
    }

    // list focus
    if (key.downArrow || hotkey === "j") {
      ui.listAt = Math.min(ui.listAt + 1, Math.max(listLength() - 1, 0));
      ui.notice = "";
      bump();
      return;
    }
    if (key.upArrow || hotkey === "k") {
      ui.listAt = Math.max(ui.listAt - 1, 0);
      ui.notice = "";
      bump();
      return;
    }

    if (ui.view === "models") {
      const rows = modelRows();
      const row = rows[ui.listAt];
      if (input === " " && row) {
        if (!row.tier) {
          // v1.90.9: an unclassified model has no tier to route on — selecting IS classifying,
          // so Space opens the same channel → tier → provenance flow instead of dying silently.
          beginClassification(row.adapter, row.model);
          return;
        }
        // OBS-994/FL-1: membership can't fix an auth failure either — the row's reach stays
        // whatever it is and the operator is pointed at doctor instead of a toggle that lies.
        if (row.evidence?.unauthed !== undefined) {
          ui.notice = `${row.adapter}:${row.model} is unauthed — re-probe with tickmarkr doctor before its fleet reach can change`;
          bump();
          return;
        }
        if (row.reach === "unknown") {
          ui.notice = `${row.adapter}:${row.model} reach is unknown — Space does not toggle it until the staged overlay loads: ${row.reasons.join("; ")}`;
          bump();
          return;
        }
        // OBS-1099 item 1: Space opens the reach picker; applyReach changes ONE selected reason
        setOverlay({ kind: "reach", target: { adapter: row.adapter, model: row.model }, at: 0 });
        return;
      }
      if (key.return && row) {
        if (!row.tier) {
          beginClassification(row.adapter, row.model);
          return;
        }
        if (row.denied || ui.denyAdapters.has(row.adapter)) {
          ui.notice = `${row.adapter}:${row.model} is out of the fleet — Space adds it before assigning`;
          bump();
          return;
        }
        // model-centric assignment: Enter pins the model to a shape (omp: Enter assigns roles)
        setOverlay({ kind: "assign", adapter: row.adapter, model: row.model, at: 0 });
        return;
      }
      if (hotkey === "l" && row) {
        if (!row.covering) {
          ui.notice = `${row.adapter}:${row.model} — no covering entry to lift${row.reasons.length ? ` — ${row.reasons.join("; ")} — Space edits this row's own entries` : ""}`;
          bump();
          return;
        }
        setOverlay({ kind: "lift", id: `${row.adapter}:${row.model}`, covering: row.covering });
        return;
      }
      if (hotkey === "t" && row) {
        if (row.tier) {
          ui.notice = "tier reassignment on classified models is not supported in v1 — edit config directly";
          bump();
          return;
        }
        beginClassification(row.adapter, row.model);
        return;
      }
      if (hotkey === "n") {
        if (ui.adapterAt === -1) {
          ui.notice = "select an adapter in the rail first — n adds a model to one adapter";
          bump();
          return;
        }
        setOverlay({ kind: "add-model", adapter: modelGroups[ui.adapterAt].adapter, text: "" });
        return;
      }
      if (hotkey === "s") {
        // OBS-508: bulk-stage every VISIBLE unclassified model carrying a catalog suggestion —
        // visible means the type-to-search filter and the retired-hide both scope the batch.
        // Adapter-scoped: first-touch channel/vendor provenance is a per-adapter answer.
        if (ui.adapterAt === -1) {
          ui.notice = "select an adapter in the rail first — s stages one adapter's suggestions";
          bump();
          return;
        }
        const group = modelGroups[ui.adapterAt];
        const suggested = rows
          .filter((candidate): candidate is ModelRow & { suggestion: FleetModelSuggestion } =>
            candidate.adapter === group.adapter && !candidate.tier && candidate.suggestion !== undefined)
          .map((candidate) => ({ model: candidate.classifyModel ?? candidate.model, suggestion: candidate.suggestion }));
        if (!suggested.length) {
          ui.notice = "no catalog tier suggestions among the visible unclassified models — evidence comes from the cached catalogs (AA index / API pricing)";
          bump();
          return;
        }
        const firstTouch = !group.rows.some((candidate) => candidate.tier !== undefined)
          && !ui.classifications.some((c) => c.adapter === group.adapter);
        if (!firstTouch) {
          stageSuggested(group.adapter, suggested);
          return;
        }
        if (!group.vendor) {
          ui.notice = `${group.adapter} has no vendor declaration — classification cannot be saved`;
          bump();
          return;
        }
        const answered = ui.channelByAdapter[group.adapter];
        if (answered) {
          stageSuggested(group.adapter, suggested, { vendor: group.vendor, channel: answered });
          return;
        }
        setOverlay({
          kind: "classify",
          adapter: group.adapter,
          model: "",
          vendor: group.vendor,
          stage: "channel",
          channelAt: 0,
          tierAt: 0,
          note: "",
          suggestion: null,
          bulk: { adapter: group.adapter, vendor: group.vendor, rows: suggested },
        });
        return;
      }
      if (hotkey === "a") {
        ui.showAll = !ui.showAll;
        clampList();
        bump();
        return;
      }
      return;
    }

    if (ui.view === "shapes") {
      const rows = shapeList();
      const shape = rows[ui.listAt]?.id;
      if (!shape) return;
      if (hotkey === "a") {
        // OBS-525: auto reverts the shape's WHOLE routing declaration — pool included, not just
        // the pin. prefer survives: it biases auto routing and is valid without pin/pool.
        const nextEntry = { ...ui.map[shape] };
        delete nextEntry.pin;
        delete nextEntry.pool;
        ui.map = { ...ui.map, [shape]: nextEntry };
        bump();
        return;
      }
      if (key.return || hotkey === "p") {
        const picked = candidatesForShape(shape, ui.selectedMode, ui.map, stagedDeny());
        setOverlay({
          kind: "candidates",
          shape,
          rows: picked.rows,
          excludedNote: picked.excludedNote,
          ledger: picked.ledger ?? [],
          // OBS-525: an existing pool round-trips — reopening the picker starts from the staged
          // channels instead of an empty selection that would silently replace the pool with a pin.
          chain: ui.map[shape]?.pool?.channels.slice() ?? [],
          at: 0,
        });
        return;
      }
      if (hotkey === "f") {
        if (ui.map[shape]?.pool !== undefined) {
          // OBS-525: pool+prefer fails the config exclusivity refine — blocking here beats
          // staging an invalid combination the reload guard bounces at the very end.
          ui.notice = `${shape} routes a pool — prefer applies to auto/pin routing; press a (auto) first or re-pool via Enter`;
          bump();
          return;
        }
        const current = ui.map[shape]?.prefer ?? [];
        setOverlay({
          kind: "prefer",
          target: { shape },
          rows: preferOptionsForShape(shape, current),
          chain: current.slice(),
          at: 0,
        });
      }
      return;
    }

    // steering view
    const rows = steeringList();
    const row = rows[ui.listAt];
    if (!row) return;
    if (key.return || hotkey === "f") {
      if (row.id === "judge") {
        setOverlay({ kind: "judge", at: 0 });
        return;
      }
      const which = row.id as FleetSteeringKey;
      const current = ui.steering[which] ?? [];
      setOverlay({
        kind: "prefer",
        target: { steering: which },
        rows: steeringOptionsFor(which, current),
        chain: current.slice(),
        at: 0,
      });
    }
  });

  // ── render ─────────────────────────────────────────────────────────────────


  const tierCell = (row: ModelRow): { text: string; color?: string; dim?: boolean } => {
    if (row.tier === "frontier") return { text: "frontier", color: INK.brand };
    if (row.tier === "mid") return { text: "mid" };
    if (row.tier === "cheap") return { text: "cheap", dim: true };
    if (row.suggestion) return { text: `→ ${row.suggestion.tier}?`, dim: true };
    return { text: "", dim: true };
  };

  const priceCell = (row: ModelRow): string => {
    const usd = fmtUsdPair(row.evidence?.inputCostPerMtok, row.evidence?.outputCostPerMtok);
    if (row.channel === "sub") return "sub";
    return usd;
  };

  // OBS-994/FL-1: the reach line — every collector scope that excludes this row, each with its
  // config path and matching entry (an unauthed row instead points at the doctor re-probe).
  const reachDetail = (row: ModelRow): string => {
    if (row.evidence?.unauthed !== undefined) return "unauthed — re-probe with tickmarkr doctor (Space does not toggle reach)";
    const reasons = row.reasons.join("; ");
    if (row.reach === "out-all") return `reach: out · all seats — ${reasons} — Space picks in or out · workers`;
    if (row.reach === "out-allow") return `reach: out · all seats · allow — ${reasons} — Space picks in or out · workers`;
    if (row.reach === "out-workers") return `reach: out · workers only (judge/review/consult unaffected) — ${reasons} — Space picks in or out · all seats`;
    if (row.reach === "unknown") return `reach: unknown — ${reasons}`;
    return "reach: in — Space picks out · workers or out · all seats";
  };

  const reachCell = (row: ModelRow): string =>
    row.reach === "in" || row.reach === "unknown" ? row.reach : `out ${row.reach === "out-workers" ? "workers" : row.reach.slice(4)}`;

  const identityDetail = (row: ModelRow): string => {
    if (row.evidence?.identity === undefined) return "";
    return row.uncoveredAlias
      ? `resolved identity ${row.evidence.identity} — no deny entry covers it`
      : `resolved identity ${row.evidence.identity}`;
  };

  // OBS-1099 item 2: a second detail line names the entry that covers this row other than by its
  // own key, its scope, and which control edits it — the ONE lift control when it is shared
  const coveringDetail = (row: ModelRow): string => {
    const covering = row.covering!;
    if (covering.shared) return `covered by ${covering.scope} (${covering.entry}) — shared: covers ${covering.covers.join(", ")} — l lifts that one entry`;
    // review round 12: name the entry each APPLICABLE reach choice edits, from the selector the
    // handler reads; when every one is the covering entry itself the short form stands
    const outAll = row.reach === "out-all" || row.reach === "out-allow";
    const applicable: Array<[string, Owned | undefined]> = [
      ["in clears", covering.edits.clear],
      ...(outAll ? [["out · workers demotes", covering.edits.demote] as [string, Owned | undefined]] : []),
      ...(row.reach === "out-workers" ? [["out · all promotes", covering.edits.promote] as [string, Owned | undefined]] : []),
    ];
    const named = applicable.filter((pair): pair is [string, Owned] => pair[1] !== undefined);
    const same = named.every(([, o]) => o.entry === covering.entry && o.scope === covering.scope);
    return `covered by ${covering.scope} (${covering.entry}) — ${same ? "Space edits that entry"
      : `Space: ${named.map(([verb, o]) => `${verb} ${o.entry} (${o.scope})`).join("; ")}`}`;
  };

  const modelDetail = (row: ModelRow): string => {
    const parts = [
      `${row.adapter}:${row.model}`,
      row.tier ?? "unclassified",
      ui.lastEdit?.id === `${row.adapter}:${row.model}` ? ui.lastEdit.text : "",
      identityDetail(row),
      row.tier ? reachDetail(row) : "",
      row.variants?.length ? `variants ${row.variants.join(", ")}` : "",
      row.classifyModel ? `classify writes ${row.classifyModel}` : "",
      row.foldedModels?.length ? `${row.foldedModels.length} gateway ids folded: ${row.foldedModels.join(", ")}` : "",
      row.evidence?.unauthed !== undefined ? `UNAUTHED — ${row.evidence.unauthed}` : "",
      row.evidence?.contextWindow !== undefined ? `${fmtCtx(row.evidence.contextWindow)} ctx` : "",
      row.evidence?.outputWindow !== undefined ? `${fmtCtx(row.evidence.outputWindow)} out` : "",
      row.evidence?.inputCostPerMtok !== undefined || row.evidence?.outputCostPerMtok !== undefined
        ? `${fmtUsdPair(row.evidence?.inputCostPerMtok, row.evidence?.outputCostPerMtok)} per Mtok`
        : (row.channel === "sub" ? "sub flat-rate quota" : ""),
      row.evidence?.probeMs !== undefined ? `probed ${fmtMs(row.evidence.probeMs)}` : "",
      row.detectedAt ? `detected ${row.detectedAt}` : "",
    ].filter(Boolean);
    return parts.join(" · ");
  };

  const renderModelRow = (row: ModelRow, selected: boolean) => {
    const tier = tierCell(row);
    const showProbe = bodyW >= 76;
    const showPrice = bodyW >= 60;
    // every cell accounted for: pointer 2 + glyph 1 + gap 1 + tier 11 + reach 12 + ctx 6 (+ price 12 + probe 7)
    const nameW = bodyW - 4 - 11 - 12 - 6 - (showPrice ? 12 : 0) - (showProbe ? 7 : 0);
    // OBS-531: deep router ids (omp/prime-agent) clip tail-preserving — the LAST segment is the
    // distinguishing half; end-clipping rendered ten identical "prime-agent/anthropic/claude-…" rows.
    const folded = row.foldedModels?.length ?? 1;
    const name = clipPathTail(`${row.adapter}/${row.model}${folded > 1 ? ` ×${folded}` : ""}`, nameW);
    const prefixLen = Math.min(name.length, row.adapter.length + 1);
    return (
      <Text key={`${row.adapter}:${row.model}`} wrap="truncate">
        <Pointer on={selected} />
        {row.reach === "out-all" || row.reach === "out-allow"
          ? <Glyph kind="off" />
          : row.evidence?.unauthed !== undefined || row.reach === "unknown"
            ? <Glyph kind="fail" />
            : row.reach === "out-workers"
              ? <Glyph kind="warn" />
              : row.tier
                ? <Glyph kind="on" />
                : <Glyph kind="unknown" />}
        <Text> </Text>
        <Text dimColor={row.denied}>
          <Text dimColor>{name.slice(0, prefixLen)}</Text>
          <Text bold={selected}>{name.slice(prefixLen).padEnd(Math.max(nameW - prefixLen, 0))}</Text>
        </Text>
        <Text color={tier.color} dimColor={tier.dim}>{padCellStart(tier.text, 11)}</Text>
        <Text dimColor={row.reach === "in"}>{padCellStart(row.tier ? reachCell(row) : "", 12)}</Text>
        <Text dimColor>{padCellStart(fmtCtx(row.evidence?.contextWindow), 6)}</Text>
        {showPrice && <Text dimColor={priceCell(row) === "sub"}>{padCellStart(priceCell(row), 12)}</Text>}
        {showProbe && <Text dimColor>{padCellStart(fmtMs(row.evidence?.probeMs), 7)}</Text>}
      </Text>
    );
  };

  const renderPlainRow = (id: string, label: string, selected: boolean, rowW = bodyW - 2) => (
    <Text key={id} wrap="truncate">
      <Pointer on={selected} />
      <Text bold={selected}>{clip(label, rowW)}</Text>
    </Text>
  );

  const renderShapeRow = (row: FleetShapeRow, selected: boolean, rowW = bodyW - 2) => {
    const prefix = `${row.id}  →  `;
    const rest = row.label.startsWith(prefix) ? row.label.slice(prefix.length) : row.label;
    // The provenance chip is the row's decision token (fleet --why parity) — it right-aligns and
    // never truncates; the assignment text absorbs the clipping instead.
    const marker = " · source: ";
    const markerAt = rest.lastIndexOf(marker);
    const body = markerAt === -1 ? rest : rest.slice(0, markerAt);
    const source = markerAt === -1 ? "" : rest.slice(markerAt + marker.length);
    const sourceCell = source ? `source: ${source}` : "";
    const bodyW2 = rowW - 12 - (sourceCell ? sourceCell.length + 2 : 0);
    return (
      <Text key={row.id} wrap="truncate">
        <Pointer on={selected} />
        <Text bold={selected} color={selected ? INK.brand : undefined}>{padCell(row.id, 10)}</Text>
        <Text>{padCell(body, Math.max(bodyW2, 8))}</Text>
        {sourceCell !== "" && <Text dimColor>{`  ${sourceCell}`}</Text>}
      </Text>
    );
  };

  const railView = (row: Extract<RailRow, { kind: "view" }>, index: number) => {
    const active = ui.view === row.view && (row.view !== "models" || ui.adapterAt === -1);
    const selected = ui.focus === "rail" && ui.railAt === index;
    return (
      <Text key={row.view}>
        {selected ? <Text color={INK.brand}>{"❯ "}</Text> : <Text>{"  "}</Text>}
        <Text bold={active} color={active ? INK.brand : undefined}>{padCell(row.label, 13)}</Text>
        <Text dimColor>{padCellStart(String(row.count), 5)}</Text>
      </Text>
    );
  };

  const railAdapter = (index: number, railIndex: number) => {
    const group = modelGroups[index];
    const agent = agents.find((candidate) => candidate.id === group.adapter);
    const denied = ui.denyAdapters.has(group.adapter) || ui.allowOut.has(group.adapter);
    const active = ui.view === "models" && ui.adapterAt === index;
    const selected = ui.focus === "rail" && ui.railAt === railIndex;
    return (
      <Text key={group.adapter}>
        {selected ? <Text color={INK.brand}>{"❯ "}</Text> : <Text>{"  "}</Text>}
        {denied ? <Glyph kind="off" /> : agent?.authed === false ? <Glyph kind="fail" /> : <Glyph kind="on" />}
        <Text> </Text>
        <Text bold={active} color={active ? INK.brand : undefined} dimColor={denied}>{padCell(group.adapter, 12)}</Text>
        <Text dimColor>{padCellStart(String(visibleCount(index)), 4)}</Text>
      </Text>
    );
  };

  const rail = railRows();
  const overlayNode = (() => {
    const overlay = ui.overlay;
    if (!overlay) return null;

    if (overlay.kind === "presets") {
      const details = modeOptions[overlay.at] ? modePreview(modeOptions[overlay.at].id, ui.map, stagedDeny()) : [];
      return (
        <OverlayPanel title={overlay.home ? "routing preset" : "routing mode"} width={bodyW}>
          <Text dimColor>{overlay.home ? "a preset routes every shape — custom opens the browser" : "floors move with the mode; the browser edits the rest"}</Text>
          <Text> </Text>
          {modeOptions.map((option, index) => (
            <Text key={option.id}>
              <Pointer on={overlay.at === index} />
              {option.id === ui.selectedMode ? <Glyph kind="on" /> : <Text> </Text>}
              <Text bold={overlay.at === index}>{` ${padCell(option.id, 12)}`}</Text>
              <Text dimColor>{clip(option.gloss, bodyW - 20)}</Text>
            </Text>
          ))}
          {overlay.home && (
            <Text>
              <Pointer on={overlay.at === modeOptions.length} />
              <Text> </Text>
              <Text bold={overlay.at === modeOptions.length}>{` ${padCell("custom", 12)}`}</Text>
              <Text dimColor>{clip("open the fleet browser (models · shapes · steering)", bodyW - 20)}</Text>
            </Text>
          )}
          <Text> </Text>
          {details.map((line) => <Text key={line} dimColor>{line}</Text>)}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "review") {
      const { visible, scroll, cap, lines } = reviewWindow(overlay);
      const below = lines.length - scroll - visible.length;
      return (
        <OverlayPanel title={`review · ${overlay.review.path}`} width={bodyW}>
          <Text dimColor wrap="truncate">{clip("everything staged lands in this one diff — y writes, n discards, ↑↓ scroll, Esc keeps editing", bodyW - 4)}</Text>
          {scroll > 0 && <ElisionMark count={scroll} side="above" />}
          {visible.map((line, index) => (
            <Text
              key={`${scroll + index}:${line}`}
              wrap="truncate"
              color={line.startsWith("+") ? INK.brand : line.startsWith("-") ? INK.fail : undefined}
              dimColor={line.startsWith("@") || line.startsWith("---") || line.startsWith("+++")}
            >
              {clip(line, bodyW - 6) || " "}
            </Text>
          ))}
          {below > 0 && <ElisionMark count={below} side="below" hint={`↓ scrolls · PgDn jumps ${cap} lines`} />}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "classify") {
      const subject = overlay.bulk
        ? `${overlay.adapter} · ${overlay.bulk.rows.length} suggested models`
        : overlay.displayModel
          ? `${overlay.adapter}:${overlay.displayModel} · writes ${overlay.model}`
          : `${overlay.adapter}:${overlay.model}`;
      return (
        <OverlayPanel title={`classify · ${subject}`} width={bodyW}>
          {overlay.stage === "channel" && (
            <>
              <Text dimColor>first touch for {overlay.adapter} — how is this CLI billed?</Text>
              <Text> </Text>
              {CHANNELS.map((channel, index) => (
                <Text key={channel}>
                  <Pointer on={overlay.channelAt === index} />
                  <Text bold={overlay.channelAt === index}>{padCell(channel, 5)}</Text>
                  <Text dimColor>{channel === "sub" ? "flat-rate subscription quota" : "metered API billing"}</Text>
                </Text>
              ))}
            </>
          )}
          {overlay.stage === "tier" && (
            <>
              <Text dimColor>
                {overlay.suggestion
                  ? `catalog suggests ${overlay.suggestion.tier} — keep it and the provenance note arrives pre-typed`
                  : "pick the capability band this model routes as"}
              </Text>
              <Text> </Text>
              {TIERS.map((tier, index) => (
                <Text key={tier}>
                  <Pointer on={overlay.tierAt === index} />
                  {overlay.suggestion?.tier === tier ? <Glyph kind="on" /> : <Text> </Text>}
                  <Text bold={overlay.tierAt === index}>{` ${padCell(tier, 9)}`}</Text>
                  <Text dimColor>
                    {tier === "frontier" ? "strongest band — integrity shapes" : tier === "mid" ? "capable daily driver" : "fast + cheap"}
                  </Text>
                </Text>
              ))}
            </>
          )}
          {overlay.stage === "note" && (
            <>
              <Text dimColor>benchmark provenance (required) — where does this tier claim come from?</Text>
              <Text> </Text>
              <Text>
                <Text color={INK.brand}>{"> "}</Text>
                <Text>{clip(overlay.note, bodyW - 6) || ""}</Text>
                <Text color={INK.brand}>█</Text>
              </Text>
            </>
          )}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "add-model") {
      return (
        <OverlayPanel title={`add model · ${overlay.adapter}`} width={bodyW}>
          <Text dimColor>type the model id exactly as the CLI names it</Text>
          <Text> </Text>
          <Text>
            <Text color={INK.brand}>{"> "}</Text>
            <Text>{clip(overlay.text, bodyW - 6)}</Text>
            <Text color={INK.brand}>█</Text>
          </Text>
        </OverlayPanel>
      );
    }

    if (overlay.kind === "assign") {
      const rows = shapeList();
      return (
        <OverlayPanel title={`pin ${overlay.adapter}:${overlay.model} to a shape`} width={bodyW}>
          <Text dimColor>Enter pins this model as the shape's route — a on the shape later reverts to auto</Text>
          <Text> </Text>
          {rows.map((row, index) => renderShapeRow(row, overlay.at === index, bodyW - 8))}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "candidates") {
      const rows = overlay.rows.filter((candidate) => matches(candidate.label, ui.filter));
      // the shape-wide captions, bounded to half the list; per-channel ledger rows are list items below
      const notes = overlay.excludedNote?.split("\n") ?? [];
      const noteRoom = Math.max(2, Math.floor(capacity / 2));
      const noteLines = notes.length > noteRoom
        ? [...notes.slice(0, noteRoom - 1), `… +${notes.length - noteRoom + 1} more notes`]
        : notes;
      const items = [
        ...rows.map((candidate) => ({ candidate, line: candidate.label })),
        ...overlay.ledger.filter((line) => matches(line, ui.filter)).map((line) => ({ candidate: undefined, line })),
      ];
      const { visible, start, above, below } = windowRows(items, overlay.at, Math.max(1, capacity - noteLines.length + 1));
      const chained = overlay.chain.length > 0;
      return (
        <OverlayPanel title={chained ? `pool · ${overlay.shape}` : `pin · ${overlay.shape}`} width={bodyW}>
          <Text dimColor wrap="truncate">{clip("Enter pins one channel · Space selects a pool in order — Enter then asks its mode (pool replaces pin)", bodyW - 4)}</Text>
          <SearchRow filter={ui.filter} active />
          {noteLines.map((line, index) =>
            <Text key={`excluded-${index}`} dimColor wrap="truncate">{clip(line, bodyW - 4)}</Text>)}
          {above > 0 && <ElisionMark count={above} side="above" />}
          {visible.map(({ candidate, line }, index) => {
            const selected = start + index === overlay.at;
            if (candidate === undefined) {
              return (
                <Text key={`ledger-${start + index}`} wrap="truncate">
                  <Pointer on={selected} />
                  <Text dimColor>{"✗ "}</Text>
                  <Text bold={selected} dimColor={!selected}>{clip(line, bodyW - 10)}</Text>
                </Text>
              );
            }
            const at = overlay.chain.indexOf(candidate.id);
            return (
              <Text key={candidate.id} wrap="truncate">
                <Pointer on={selected} />
                {at === -1 ? <Text dimColor>{"· "}</Text> : <Text color={INK.brand}>{`${at + 1} `}</Text>}
                <Text bold={selected}>{clip(candidate.label, bodyW - 10)}</Text>
              </Text>
            );
          })}
          {below > 0 && <ElisionMark count={below} side="below" />}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "poolmode") {
      const modes = [
        { id: "any", gloss: "economy engine picks within your selection (cost, then tier)" },
        { id: "ordered", gloss: "walk your selection in order; first live wins" },
      ];
      return (
        <OverlayPanel title={`pool mode · ${overlay.picker.shape}`} width={bodyW}>
          <Text dimColor>{clip(`pool: ${overlay.picker.chain.join(" → ")}`, bodyW - 4)}</Text>
          <Text> </Text>
          {modes.map((mode, index) => (
            <Text key={mode.id}>
              <Pointer on={overlay.at === index} />
              <Text bold={overlay.at === index}>{padCell(mode.id, 9)}</Text>
              <Text dimColor>{clip(`— ${mode.gloss}`, bodyW - 14)}</Text>
            </Text>
          ))}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "prefer") {
      const title = "shape" in overlay.target ? `${overlay.target.shape}.prefer` : `${overlay.target.steering}.prefer`;
      const rows = overlay.rows.filter((option) => matches(option, ui.filter));
      const { visible, start, above, below } = windowRows(rows, overlay.at, capacity);
      return (
        <OverlayPanel title={`edit · ${title}`} width={bodyW}>
          <Text dimColor wrap="truncate">{clip("Space adds/drops in order · Enter applies (empty clears) · ordered chain wins routing ties", bodyW - 4)}</Text>
          <SearchRow filter={ui.filter} active />
          {above > 0 && <ElisionMark count={above} side="above" />}
          {visible.map((option, index) => {
            const at = overlay.chain.indexOf(option);
            const selected = start + index === overlay.at;
            return (
              <Text key={option}>
                <Pointer on={selected} />
                {at === -1 ? <Text dimColor>{"· "}</Text> : <Text color={INK.brand}>{`${at + 1} `}</Text>}
                <Text bold={selected}>{clip(option, bodyW - 10)}</Text>
              </Text>
            );
          })}
          {below > 0 && <ElisionMark count={below} side="below" />}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "lift") {
      return (
        <OverlayPanel title={`lift · ${overlay.covering.scope} (${overlay.covering.entry})`} width={bodyW}>
          <Text dimColor>{clip(`from ${overlay.id} — Enter lifts this ONE entry for every channel it covers · Esc keeps it`, bodyW - 4)}</Text>
          <Text> </Text>
          {overlay.covering.covers.map((covered) => (
            <Text key={covered} wrap="truncate">{clip(`  ${covered}`, bodyW - 4)}</Text>
          ))}
        </OverlayPanel>
      );
    }

    if (overlay.kind === "reach") {
      const id = overlay.target.model === undefined ? overlay.target.adapter : `${overlay.target.adapter}:${overlay.target.model}`;
      const current = overlay.target.model === undefined
        ? adapterReach(overlay.target.adapter)
        : modelRows().find((row) => row.adapter === overlay.target.adapter && row.model === overlay.target.model) ?? { reach: "unknown", reasons: [] };
      const partial = "partial" in current && current.partial;
      // D-205: a partial rail marks no choice as selected — its channels disagree
      const on: ReachChoice | null = partial || current.reach === "unknown" ? null
        : current.reach === "out-all" || current.reach === "out-allow" ? "out-all" : current.reach;
      return (
        <OverlayPanel title={`reach · ${id}`} width={bodyW}>
          <Text dimColor>{clip(`now: ${describeReach({ reach: current.reach, partial })}${current.reasons.length ? ` — ${current.reasons.join("; ")}` : ""}`, bodyW - 4)}</Text>
          <Text dimColor>one choice edits one reason; a row with more reasons keeps the rest</Text>
          <Text> </Text>
          {REACH_CHOICES.map((choice, index) => (
            <Text key={choice.id}>
              <Pointer on={overlay.at === index} />
              {choice.id === on ? <Glyph kind="on" /> : <Text> </Text>}
              <Text bold={overlay.at === index}>{` ${padCell(choice.label, 16)}`}</Text>
              <Text dimColor>{clip(`— ${choice.gloss}`, bodyW - 24)}</Text>
            </Text>
          ))}
        </OverlayPanel>
      );
    }

    // judge
    const rows = [judgeKeepRow, ...judgeSeats].filter((row) => matches(row, ui.filter));
    const { visible, start, above, below } = windowRows(rows, overlay.at, capacity);
    const selectedSeat = ui.judgeSeat ?? judgeKeepRow;
    return (
      <OverlayPanel title="pick · judge" width={bodyW}>
        <Text dimColor>one seat judges acceptance criteria — failover stays runtime (GATE-09)</Text>
        <SearchRow filter={ui.filter} active />
        {above > 0 && <ElisionMark count={above} side="above" />}
        {visible.map((label, index) => (
          <Text key={label}>
            <Pointer on={start + index === overlay.at} />
            {label === selectedSeat ? <Glyph kind="on" /> : <Text> </Text>}
            <Text bold={start + index === overlay.at}>{` ${clip(label, bodyW - 10)}`}</Text>
          </Text>
        ))}
        {below > 0 && <ElisionMark count={below} side="below" />}
      </OverlayPanel>
    );
  })();

  const modelVisibilityLine = (): string => {
    const hidden = hiddenModelCount();
    const folded = foldedModelCount();
    return [
      ...(folded ? [`${folded} same-model gateway id${folded === 1 ? "" : "s"} folded`] : []),
      ...(hidden ? [`${hidden} retired/preview/non-worker hidden — a shows all`] : []),
      ...(ui.showAll ? ["showing retired models — a hides them again"] : []),
    ].join(" · ");
  };

  const listNode = (() => {
    if (overlayNode) return overlayNode;
    if (ui.view === "models") {
      const rows = modelRows();
      const { visible, start, above, below } = windowRows(rows, ui.listAt, capacity);
      const scopeLabel = ui.adapterAt === -1
        ? "All models"
        : modelGroups[ui.adapterAt]?.adapter ?? "";
      // OBS-994/FL-1 repair: an adapter-wide deny (flat or workers) no longer hides this
      // scope's rows — every channel still needs its own reach cell, toggleable right here.
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>{scopeLabel}</Text>
            <Text dimColor>{`  ${rows.length}`}</Text>
          </Text>
          <SearchRow filter={ui.filter} active={ui.searching} hint="/ to search" />
          {modelVisibilityLine() && <Text dimColor>{`  ${modelVisibilityLine()}`}</Text>}
          {above > 0 && <ElisionMark count={above} side="above" />}
          {visible.map((row, index) => renderModelRow(row, ui.focus === "list" && start + index === ui.listAt))}
          {below > 0 && <ElisionMark count={below} side="below" hint="/ to search" />}
          {rows.length === 0 && <Text dimColor>{"  no models match"}</Text>}
        </Box>
      );
    }
    if (ui.view === "shapes") {
      const rows = shapeList();
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>Shapes</Text>
            <Text dimColor>{`  routed under ${ui.selectedMode}`}</Text>
          </Text>
          <Text> </Text>
          {rows.map((row, index) => renderShapeRow(row, ui.focus === "list" && index === ui.listAt))}
        </Box>
      );
    }
    const rows = steeringList();
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Steering</Text>
          <Text dimColor>{"  review · consult · judge"}</Text>
        </Text>
        <Text> </Text>
        {rows.map((row, index) => renderPlainRow(row.id, row.label, ui.focus === "list" && index === ui.listAt))}
      </Box>
    );
  })();

  // ── footer ─────────────────────────────────────────────────────────────────

  const detailLines = (): string[] => {
    if (ui.notice) return [ui.notice];
    const overlay = ui.overlay;
    if (overlay) {
      if (overlay.kind === "candidates") {
        const rows = overlay.rows.filter((candidate) => matches(candidate.label, ui.filter));
        const ledger = overlay.ledger.filter((line) => matches(line, ui.filter));
        const line = rows[overlay.at]?.label ?? ledger[overlay.at - rows.length];
        return line ? [line] : [];
      }
      if (overlay.kind === "prefer") {
        return overlay.chain.length ? [`chain: ${overlay.chain.join(" → ")}`] : [];
      }
      return [];
    }
    if (ui.view === "models") {
      const rows = modelRows();
      const row = rows[ui.listAt];
      const lines: string[] = [];
      if (row) {
        lines.push(modelDetail(row));
        if (row.covering) lines.push(coveringDetail(row));
        if (!row.tier) {
          lines.push(row.suggestion
            ? `catalog suggests ${row.suggestion.tier} — Space/Enter classifies with the note pre-typed · s stages every visible suggestion`
            : "unclassified — Space/Enter classifies; unclassified models are never routed");
        }
      }
      return lines;
    }
    if (ui.view === "shapes") {
      const row = shapeList()[ui.listAt];
      return row ? [row.label] : [];
    }
    const row = steeringList()[ui.listAt];
    return row ? [row.label] : [];
  };

  const keyBinds = (): KeyBind[] => {
    const overlay = ui.overlay;
    if (overlay) {
      if (overlay.kind === "presets") {
        return overlay.home
          ? [{ key: "Enter", label: "apply preset" }, { key: "↑↓", label: "move" }, { key: "Esc", label: "quit" }]
          : [{ key: "Enter", label: "set mode" }, { key: "↑↓", label: "move" }, { key: "Esc", label: "back" }];
      }
      if (overlay.kind === "review") {
        return [{ key: "y", label: "write" }, { key: "n", label: "discard" }, { key: "↑↓", label: "scroll" }, { key: "Esc", label: "keep editing" }];
      }
      if (overlay.kind === "classify") {
        return overlay.stage === "note"
          ? [{ key: "type", label: "note" }, { key: "Enter", label: "stage" }, { key: "Esc", label: "cancel" }]
          : [{ key: "↑↓", label: "move" }, { key: "Enter", label: "next" }, { key: "Esc", label: "cancel" }];
      }
      if (overlay.kind === "assign") {
        // OBS-526: assign has no search box — advertising "type search" here promised a dead key
        return [{ key: "Enter", label: "pin to shape" }, { key: "↑↓", label: "move" }, { key: "Esc", label: "cancel" }];
      }
      if (overlay.kind === "add-model") {
        return [{ key: "type", label: "model id" }, { key: "Enter", label: "classify" }, { key: "Esc", label: "cancel" }];
      }
      if (overlay.kind === "prefer") {
        return [{ key: "Space", label: "add/drop" }, { key: "Enter", label: "apply" }, { key: "type", label: "search" }, { key: "Esc", label: "cancel" }];
      }
      if (overlay.kind === "candidates") {
        return [
          { key: "Enter", label: overlay.chain.length ? "apply pool" : "pin · lift greyed" },
          { key: "Space", label: "pool in order" },
          { key: "type", label: "search" },
          { key: "Esc", label: "cancel" },
        ];
      }
      if (overlay.kind === "reach") {
        return [{ key: "Enter", label: "set reach" }, { key: "↑↓", label: "move" }, { key: "Esc", label: "cancel" }];
      }
      if (overlay.kind === "lift") {
        return [{ key: "Enter", label: "lift entry" }, { key: "Esc", label: "keep" }];
      }
      if (overlay.kind === "poolmode") {
        return [
          { key: "Enter", label: "apply pool" },
          { key: "↑↓", label: "move" },
          { key: "Esc", label: "back to picker" },
        ];
      }
      return [{ key: "Enter", label: "select" }, { key: "↑↓", label: "move" }, { key: "type", label: "search" }, { key: "Esc", label: "cancel" }];
    }
    if (ui.searching) {
      return [
        { key: "type", label: "filter" },
        { key: "Enter", label: "apply" },
        { key: "↑↓", label: "move" },
        { key: "Esc", label: "cancel" },
      ];
    }
    const escLabel = ui.filter !== "" ? "clear search" : entry === "presets" ? "presets" : "quit";
    if (ui.focus === "rail") {
      return [
        { key: "Enter", label: "open" },
        { key: "↑↓", label: "move" },
        { key: "Space", label: "reach picker (CLI)" },
        { key: "→", label: "list" },
        { key: "w", label: "review + write" },
        { key: "Esc", label: escLabel },
      ];
    }
    if (ui.view === "models") {
      return [
        { key: "Enter", label: "assign/classify" },
        { key: "Space", label: "reach picker" },
        { key: "l", label: "lift entry" },
        { key: "m", label: "presets" },
        { key: "w", label: "review + write" },
        { key: "←", label: "rail" },
        { key: "/", label: "search" },
        { key: "Esc", label: escLabel },
      ];
    }
    if (ui.view === "shapes") {
      return [
        { key: "Enter", label: "pin from candidates" },
        { key: "f", label: "prefer chain" },
        { key: "a", label: "auto" },
        { key: "w", label: "review + write" },
        { key: "←", label: "rail" },
        { key: "Esc", label: escLabel },
      ];
    }
    return [
      { key: "Enter", label: "edit" },
      { key: "w", label: "review + write" },
      { key: "←", label: "rail" },
      { key: "Esc", label: escLabel },
    ];
  };

  const details = detailLines();
  const staged = stagedCount();
  return (
    <Box flexDirection="column" width={width} height={frameRows}>
      <Text>
        <Text bold color={INK.brand}>{" tickmarkr fleet"}</Text>
        <Text dimColor>{entry === "presets" ? " · init act 3 of 3" : ""}</Text>
        <Text dimColor>{` · probe ${formatDoctorAge(ageMs)} · mode `}</Text>
        <Text>{ui.selectedMode}</Text>
        {staged > 0 && <Text color={INK.warn}>{` · ${staged} staged`}</Text>}
      </Text>
      <Box flexGrow={1} borderStyle="round" borderDimColor>
        <Box width={RAIL_W} flexDirection="column" paddingLeft={1} paddingTop={1}>
          {rail.slice(0, 3).map((row, index) => railView(row as Extract<RailRow, { kind: "view" }>, index))}
          <Text dimColor>{"─".repeat(RAIL_W - 2)}</Text>
          {rail.slice(3).map((row, index) =>
            railAdapter((row as Extract<RailRow, { kind: "adapter" }>).index, index + 3))}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1} borderStyle="single" borderDimColor borderTop={false} borderBottom={false} borderRight={false}>
          {listNode}
        </Box>
      </Box>
      {ui.notice
        ? <Text color={INK.warn}>{` ! ${clip(ui.notice, width - 4)}`}</Text>
        : details.map((line) => <Text key={line} dimColor>{` ${clip(line, width - 2)}`}</Text>)}
      <KeyBar binds={keyBinds()} />
    </Box>
  );
}


export async function runFleetInkEditor({
  ageMs,
  adapters,
  health,
  initialAllowOut = [],
  modelGroups,
  initialMode,
  modeOptions,
  initialMap,
  modePreview,
  shapeRows,
  candidatesForShape,
  preferOptionsForShape,
  initialSteering,
  steeringOptionsFor,
  reviewOverlay,
  reloadGuard,
  stagedRouting,
  entry = "probe",
  initialJudge = "",
  judgeSeats = [],
  initialInput = [],
  input,
  output,
  debug = false,
  ...initialDenyProps
}: InitialDenyProps & {
  ageMs: number | null;
  adapters: WorkerAdapter[];
  health: Record<string, AuthHealth>;
  /** OBS-1046: adapter ids and adapter:model keys routing.allow leaves out of the fleet */
  initialAllowOut?: string[];
  modelGroups: FleetModelGroup[];
  initialMode: RoutingMode;
  modeOptions: FleetModeOption[];
  initialMap: Record<string, MapEntry>;
  modePreview: (mode: RoutingMode, map: Record<string, MapEntry>, deny: FleetStagedDeny) => string[];
  shapeRows: (mode: RoutingMode, map: Record<string, MapEntry>, deny: FleetStagedDeny) => FleetShapeRow[];
  candidatesForShape: (
    shape: Shape,
    mode: RoutingMode,
    map: Record<string, MapEntry>,
    deny: FleetStagedDeny,
  ) => { rows: FleetCandidateOption[]; excludedNote?: string; ledger?: string[] };
  preferOptionsForShape: (shape: Shape, current: string[]) => string[];
  initialSteering: Record<FleetSteeringKey, string[] | undefined>;
  steeringOptionsFor: (which: FleetSteeringKey, current: string[]) => string[];
  reviewOverlay: (state: FleetEditorState) => FleetOverlayReview;
  reloadGuard: (bytes: string) => string | null;
  /** the routing policy the staged deny sets load as (fleet: the config loader over the candidate
   * bytes); absent ⇒ the four staged sets alone, with no allowlist */
  stagedRouting?: (deny: FleetStagedDeny) => FleetStagedRouting;
  /** "presets" = init's entry: Esc in the browser is HOME to the preset overlay, not quit */
  entry?: "presets" | "probe";
  initialJudge?: string;
  judgeSeats?: string[];
  initialInput?: string[];
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  debug?: boolean;
}): Promise<FleetEditorResult> {
  const agents = adapters.flatMap((adapter) => {
    const state = health[adapter.id];
    if (!state?.installed) return [];
    return [{
      id: adapter.id,
      version: state.version ?? "installed",
      authed: state.authed,
    }];
  });
  const vendors = new Map(adapters.map((adapter) => [adapter.id, adapter.vendor]));
  const declaredModelGroups = modelGroups.map((group) => ({
    ...group,
    vendor: group.vendor ?? vendors.get(group.adapter),
  }));
  const bridgedInput = inkInput(input, initialInput);
  const legacyOutput = typeof output.on !== "function" || typeof output.off !== "function";
  const realTty = output === process.stdout && output.isTTY === true;
  const leaveAltScreen = enterAltScreen(output);
  // OBS-527: the terminal geometry is a LIVE input, not a launch constant — the element is
  // rebuilt from output.columns/rows so a pane resize re-renders at the new size. Same root
  // element type on every rerender ⇒ React keeps the component instance, so staged edits,
  // cursor, and overlays all survive the resize.
  const editorElement = () => (
    <FleetApp
      ageMs={ageMs}
      agents={agents}
      {...initialDenyProps}
      initialAllowOut={initialAllowOut}
      modelGroups={declaredModelGroups}
      initialMode={initialMode}
      modeOptions={modeOptions}
      initialMap={initialMap}
      modePreview={modePreview}
      shapeRows={shapeRows}
      candidatesForShape={candidatesForShape}
      preferOptionsForShape={preferOptionsForShape}
      initialSteering={initialSteering}
      steeringOptionsFor={steeringOptionsFor}
      reviewOverlay={reviewOverlay}
      reloadGuard={reloadGuard}
      stagedRouting={stagedRouting}
      entry={entry}
      initialJudge={initialJudge}
      judgeSeats={judgeSeats}
      // v1.90.9: cap every list to the terminal minus chrome so the cursor and header can
      // never scroll off-screen (omp's 218-model list did exactly that pre-cap).
      // OBS-523: chrome is ≤12 rows worst case (header, borders, padding, scope+search,
      // elisions, two detail lines, keybar) — the old -16 blanked six list rows at every size.
      viewRows={Math.max(8, (output.rows ?? 40) - 12)}
      frameColumns={output.columns ?? 100}
      frameRows={realTty ? output.rows : undefined}
    />
  );
  const app = render(editorElement(), {
    // FleetIO's injected stream predates Ink and did not require ref/unref.
    // Real terminal streams pass through unchanged; the compatibility facade
    // adds only those lifecycle methods and leaves input decoding to Ink.
    stdin: bridgedInput.stream,
    stdout: inkOutput(output),
    exitOnCtrlC: false,
    patchConsole: false,
    // Legacy FleetIO outputs collected one complete frame per keypress before the Ink
    // migration. Disable Ink's render throttling only for that injected facade so a
    // cold-start byte sequence cannot collapse intermediate compatibility frames.
    debug: debug || legacyOutput,
  });
  const onResize = () => app.rerender(editorElement());
  if (!legacyOutput) output.on("resize", onResize);
  let result: FleetEditorResult | undefined;
  try {
    result = await app.waitUntilExit() as FleetEditorResult;
    return result;
  } finally {
    if (!legacyOutput) output.off("resize", onResize);
    app.unmount();
    bridgedInput.stop();
    leaveAltScreen();
  }
}
