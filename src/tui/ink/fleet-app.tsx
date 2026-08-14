import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { render, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import { MODEL_ID_RE, type AuthHealth, type WorkerAdapter } from "../../adapters/types.js";
import { retiredModelReason } from "../../adapters/model-lints.js";
import type { MapEntry, RoutingMode, Tier } from "../../config/config.js";
import { fleetFirstTouchProvenance } from "../../config/fleet-overlay.js";
import { TIERS, type Shape } from "../../graph/schema.js";
import { FleetListScreen, FleetReviewScreen, ToggleMark, type FleetListRow } from "./components.js";

export type FleetSteeringKey = "review" | "consult";
const STEERING_KEYS: FleetSteeringKey[] = ["review", "consult"];

export type FleetEditorState = {
  denyAdapters: string[];
  denyModels: string[];
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

export type FleetModelGroup = {
  adapter: string;
  vendor?: string;
  // OBS-508: `suggestion` is catalog evidence (catalogModelAdvisory) — prefills the classify flow
  // and feeds the bulk `s` stage; tickmarkr still never WRITES a tier without the review diff.
  rows: Array<{ model: string; tier?: Tier; detectedAt?: string; suggestion?: FleetModelSuggestion }>;
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
};

const escape = String.fromCharCode(27);
const CHANNELS = ["sub", "api"] as const;
const inkBookkeepingWrites = new Set(["", `${escape}[?25l`, `${escape}[?25h`, `${escape}[?2026h`, `${escape}[?2026l`]);

function inkOutput(output: NodeJS.WriteStream): NodeJS.WriteStream {
  if (typeof output.on === "function" && typeof output.off === "function") return output;
  const facade = Object.create(output) as NodeJS.WriteStream;
  const write = output.write.bind(output);
  facade.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (inkBookkeepingWrites.has(text)) return true;
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as NodeJS.WriteStream["write"];
  facade.on = () => facade;
  facade.off = () => facade;
  return facade;
}

function inkInput(input: NodeJS.ReadStream, initialInput: string[]) {
  const productionInput = typeof input.ref === "function" && typeof input.unref === "function";
  // Isolate Ink's listeners on a bridge so every editor exit can detach the
  // one listener it owns from the operator's terminal. Older injected FleetIO
  // streams can arrive as decoded keypress events, while real TTYs forward raw
  // data and leave decoding entirely to Ink.
  const stream = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  stream.isTTY = input.isTTY;
  stream.setRawMode = input.setRawMode?.bind(input);
  stream.ref = () => {
    if (productionInput) input.ref();
    return stream as unknown as NodeJS.ReadStream;
  };
  stream.unref = () => {
    if (productionInput) input.unref();
    return stream as unknown as NodeJS.ReadStream;
  };

  const queued = [...initialInput];
  let active = true;
  let scheduled: NodeJS.Timeout | undefined;
  const pump = () => {
    scheduled = undefined;
    if (!active) return;
    const next = queued.shift();
    if (next === undefined) return;
    stream.write(next);
    scheduled = setTimeout(pump, 0);
  };
  const onData = (chunk: string | Buffer) => {
    queued.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    scheduled ??= setTimeout(pump, 0);
  };
  const onKeypress = (sequence: string | undefined, key: { sequence?: string } | undefined) => {
    const token = key?.sequence ?? sequence;
    if (token === undefined) return;
    queued.push(token);
    scheduled ??= setTimeout(pump, 0);
  };
  if (productionInput) {
    input.on("data", onData);
  } else {
    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
  }
  input.resume();
  if (queued.length > 0) scheduled = setTimeout(pump, 0);

  return {
    stream: stream as unknown as NodeJS.ReadStream,
    stop() {
      active = false;
      if (scheduled) clearTimeout(scheduled);
      if (productionInput) input.off("data", onData);
      else input.off("keypress", onKeypress);
      input.pause();
      stream.end();
    },
  };
}

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

export function FleetApp({
  ageMs,
  agents,
  initialDenyAdapters,
  initialDenyModels,
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
  entry = "probe",
  initialJudge = "",
  judgeSeats = [],
  viewRows = Number.POSITIVE_INFINITY,
}: {
  ageMs: number | null;
  agents: AgentCli[];
  initialDenyAdapters: string[];
  initialDenyModels: string[];
  modelGroups: FleetModelGroup[];
  initialMode: RoutingMode;
  modeOptions: FleetModeOption[];
  initialMap: Record<string, MapEntry>;
  modePreview: (mode: RoutingMode, map: Record<string, MapEntry>) => string[];
  shapeRows: (mode: RoutingMode, map: Record<string, MapEntry>) => FleetShapeRow[];
  candidatesForShape: (
    shape: Shape,
    mode: RoutingMode,
    map: Record<string, MapEntry>,
  ) => FleetCandidateOption[];
  preferOptionsForShape: (shape: Shape, current: string[]) => string[];
  initialSteering: Record<FleetSteeringKey, string[] | undefined>;
  steeringOptionsFor: (which: FleetSteeringKey, current: string[]) => string[];
  reviewOverlay: (state: FleetEditorState) => FleetOverlayReview;
  reloadGuard: (bytes: string) => string | null;
  // "presets" starts on the routing-mode screen with an extra `custom` row (init's entry point);
  // "probe" is the classic six-step walk, byte-for-byte the pre-entry behavior.
  entry?: "presets" | "probe";
  /** resolved config judge as "adapter:model" — shown on the (keep default) picker row */
  initialJudge?: string;
  /** discovered adapter:model seats — the judge picker universe */
  judgeSeats?: string[];
  /** list viewport capacity (terminal rows minus chrome) — long lists window around the cursor */
  viewRows?: number;
}) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<
    | "probe"
    | "agents"
    | "models"
    | "add-model"
    | "channel"
    | "tiers"
    | "provenance"
    | "modes"
    | "shapes"
    | "candidates"
    | "shape-prefer"
    | "steering"
    | "steering-prefer"
    | "judge-pick"
    | "review"
  >(entry === "presets" ? "modes" : "probe");
  const screenRef = useRef(screen);
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(cursor);
  const denyRef = useRef<Set<string> | undefined>(undefined);
  denyRef.current ??= new Set(initialDenyAdapters);
  const [denyAdapters, setDenyAdapters] = useState(() => new Set(initialDenyAdapters));
  const denyModelsRef = useRef<Set<string> | undefined>(undefined);
  denyModelsRef.current ??= new Set(initialDenyModels);
  const [denyModels, setDenyModels] = useState(() => new Set(initialDenyModels));
  const classificationsRef = useRef<FleetClassification[]>([]);
  const [, setClassificationRevision] = useState(0);
  const modelGroupRef = useRef(0);
  const [modelGroup, setModelGroup] = useState(0);
  const modelCursorRef = useRef(0);
  const [modelCursor, setModelCursor] = useState(0);
  const modelIdRef = useRef("");
  const [modelId, setModelId] = useState("");
  const channelCursorRef = useRef(0);
  const [channelCursor, setChannelCursor] = useState(0);
  const channelByAdapterRef = useRef<Record<string, "sub" | "api">>({});
  const tierCursorRef = useRef(0);
  const [tierCursor, setTierCursor] = useState(0);
  const pendingClassificationRef = useRef<Omit<FleetClassification, "note"> | null>(null);
  // OBS-508: the suggestion riding the in-flight classification (prefills tier + note), and the
  // rows a bulk `s` staged while waiting on the one first-touch channel answer.
  const pendingSuggestionRef = useRef<FleetModelSuggestion | null>(null);
  const bulkRef = useRef<{ group: FleetModelGroup; rows: Array<{ model: string; suggestion: FleetModelSuggestion }> } | null>(null);
  const noteRef = useRef("");
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const modeCursorRef = useRef<number | undefined>(undefined);
  modeCursorRef.current ??= Math.max(modeOptions.findIndex((option) => option.id === initialMode), 0);
  const [modeCursor, setModeCursor] = useState(modeCursorRef.current);
  const selectedModeRef = useRef(initialMode);
  const mapRef = useRef<Record<string, MapEntry> | undefined>(undefined);
  mapRef.current ??= structuredClone(initialMap);
  const [map, setMap] = useState(() => structuredClone(initialMap));
  const shapeCursorRef = useRef(0);
  const [shapeCursor, setShapeCursor] = useState(0);
  const candidateCursorRef = useRef(0);
  const [candidateCursor, setCandidateCursor] = useState(0);
  const candidatesRef = useRef<FleetCandidateOption[]>([]);
  const preferCursorRef = useRef(0);
  const [preferCursor, setPreferCursor] = useState(0);
  const preferRowsRef = useRef<string[]>([]);
  const preferChainRef = useRef<string[]>([]);
  const [, setPreferRevision] = useState(0);
  const steeringRef = useRef<Record<FleetSteeringKey, string[] | undefined> | undefined>(undefined);
  steeringRef.current ??= structuredClone(initialSteering);
  const [steering, setSteering] = useState(() => structuredClone(initialSteering));
  const steeringCursorRef = useRef(0);
  const [steeringCursor, setSteeringCursor] = useState(0);
  const steeringPickerRef = useRef<FleetSteeringKey>("review");
  const steeringRowsRef = useRef<string[]>([]);
  const steeringChainRef = useRef<string[]>([]);
  const steeringPickerCursorRef = useRef(0);
  const [steeringPickerCursor, setSteeringPickerCursor] = useState(0);
  const [, setSteeringPickerRevision] = useState(0);
  const judgeCursorRef = useRef(0);
  const [judgeCursor, setJudgeCursor] = useState(0);
  const judgeSeatRef = useRef<string | null>(null);
  const [judgeSeat, setJudgeSeat] = useState<string | null>(null);
  const reviewRef = useRef<Extract<FleetOverlayReview, { kind: "diff" }> | null>(null);
  const [review, setReview] = useState<Extract<FleetOverlayReview, { kind: "diff" }> | null>(null);
  const doneRef = useRef(false);
  // entry === "presets": the first modes visit is the preset pick (mode → review, custom → the
  // full walk). Once custom is chosen this flips off and modes behaves exactly as in probe entry.
  const presetPickRef = useRef(entry === "presets");
  // type-to-search on the long lists — reset on every screen change (per-screen-visit filter)
  const filterRef = useRef("");
  const [filter, setFilter] = useState("");
  // `a` on the models screen reveals retired/preview/non-worker shapes; sticky for the session.
  const showAllModelsRef = useRef(false);
  const [, setShowAllModels] = useState(false);

  const enabledModelGroups = () => modelGroups.filter((group) => !denyRef.current?.has(group.adapter));
  const stagedMap = () => mapRef.current as Record<string, MapEntry>;
  const currentModelRows = () => {
    const group = enabledModelGroups()[modelGroupRef.current];
    if (!group) return [];
    const rows = group.rows.map((row) => {
      const staged = classificationsRef.current.find(
        (classification) => classification.adapter === group.adapter && classification.model === row.model,
      );
      return staged ? { ...row, tier: staged.tier } : row;
    });
    const known = new Set(rows.map((row) => row.model));
    for (const staged of classificationsRef.current) {
      if (staged.adapter === group.adapter && !known.has(staged.model)) {
        rows.push({ model: staged.model, tier: staged.tier });
      }
    }
    return rows;
  };
  // type-to-search over the long lists: plain case-insensitive substring on the row's visible
  // label. Each filterable screen derives its rows through these so input and render agree.
  const matches = (label: string, f = filterRef.current) =>
    f === "" || label.toLowerCase().includes(f.toLowerCase());
  // Operator directive 2026-08-13: retired shapes (dated snapshots, previews, non-worker SKUs,
  // legacy families) hide by DEFAULT — omp reports 218 ids and most can never carry a worker.
  // `a` reveals them; a CLASSIFIED row is never hidden (a tiered dated snapshot was meant).
  const filteredModelRows = (f = filterRef.current) =>
    currentModelRows().filter((row) =>
      matches(row.model, f)
      && (showAllModelsRef.current || row.tier !== undefined || retiredModelReason(row.model) === null));
  const hiddenModelCount = (f = filterRef.current) =>
    currentModelRows().filter((row) => matches(row.model, f)).length - filteredModelRows(f).length;
  const filteredCandidates = (f = filterRef.current) =>
    candidatesRef.current.filter((candidate) => matches(candidate.label, f));
  const filteredSteeringRows = (f = filterRef.current) =>
    steeringRowsRef.current.filter((option) => matches(option, f));
  const judgeKeepRow = initialJudge ? `(keep default)  ${initialJudge}` : "(keep default)";
  const filteredJudgeRows = (f = filterRef.current) =>
    [judgeKeepRow, ...judgeSeats].filter((row) => matches(row, f));

  // Shared filter-edit tail for the filterable screens: hotkeys run first in each screen block,
  // whatever printable input is left appends here (space stays a toggle key, never a filter char).
  const filterInput = (
    countFor: (f: string) => number,
    cursorRef: { current: number },
    setCursorState: (next: number) => void,
    input: string,
    key: { backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean },
  ): boolean => {
    // printable chars only: "\r" reaches here when an emptied list makes key.return a no-op
    const printable = input > " " && !key.ctrl && !key.meta;
    const next = key.backspace || key.delete
      ? filterRef.current.slice(0, -1)
      : (printable ? filterRef.current + input : null);
    if (next === null) return false;
    filterRef.current = next;
    setFilter(next);
    const clamped = Math.min(cursorRef.current, Math.max(countFor(next) - 1, 0));
    cursorRef.current = clamped;
    setCursorState(clamped);
    return true;
  };

  const editorState = (): FleetEditorState => ({
    denyAdapters: [...(denyRef.current ?? [])].sort(),
    denyModels: [...(denyModelsRef.current ?? [])].sort(),
    classifications: classificationsRef.current.map((classification) =>
      classification.vendor && classification.channel
        ? {
          ...classification,
          note: fleetFirstTouchProvenance(classification.note, {
            vendor: classification.vendor,
            channel: classification.channel,
          }),
        }
        : classification),
    selectedMode: selectedModeRef.current,
    map: stagedMap(),
    ...(judgeSeatRef.current ? { judgeSeat: splitSeat(judgeSeatRef.current) } : {}),
    steering: structuredClone(steeringRef.current as Record<FleetSteeringKey, string[] | undefined>),
  });

  const finish = (result: FleetEditorResult) => {
    if (doneRef.current) return;
    doneRef.current = true;
    exit(result);
  };

  const finishEditor = () => {
    showScreen("steering");
  };

  const showScreen = (next: typeof screen) => {
    filterRef.current = "";
    setFilter("");
    screenRef.current = next;
    setScreen(next);
  };

  // The one review funnel: an empty staged overlay finishes as no-changes, a real diff shows the
  // confirm screen. Reached from the steering enter and, in preset entry, from a mode pick.
  const goReview = () => {
    const nextReview = reviewOverlay(editorState());
    if (nextReview.kind === "empty") {
      finish({ kind: "no-changes" });
      return;
    }
    reviewRef.current = nextReview as Extract<FleetOverlayReview, { kind: "diff" }>;
    setReview(reviewRef.current);
    setNotice("");
    showScreen("review");
  };

  const stageSuggested = (
    group: FleetModelGroup,
    rows: Array<{ model: string; suggestion: FleetModelSuggestion }>,
    firstTouch?: { vendor: string; channel: "sub" | "api" },
  ) => {
    const staged = rows.map((row) => ({
      adapter: group.adapter,
      model: row.model,
      tier: row.suggestion.tier,
      note: row.suggestion.note,
      ...firstTouch,
    }));
    classificationsRef.current = [...classificationsRef.current, ...staged];
    setClassificationRevision((revision) => revision + 1);
    setNotice(`fleet: staged ${staged.length} catalog-suggested classification(s) — nothing writes before the review diff`);
  };

  const beginClassification = (group: FleetModelGroup, model: string) => {
    // OBS-508: catalog evidence prefills the flow — tier cursor lands on the suggested band and
    // (when the operator keeps that band) the provenance note arrives pre-typed. Free to override.
    const suggestion = group.rows.find((row) => row.model === model)?.suggestion ?? null;
    pendingSuggestionRef.current = suggestion;
    const tierAt = suggestion ? Math.max(TIERS.indexOf(suggestion.tier), 0) : 0;
    tierCursorRef.current = tierAt;
    setTierCursor(tierAt);
    const firstTouch = !group.rows.some((row) => row.tier !== undefined);
    const pending: Omit<FleetClassification, "note"> = {
      adapter: group.adapter,
      model,
      tier: TIERS[0],
    };
    if (!firstTouch) {
      pendingClassificationRef.current = pending;
      showScreen("tiers");
      return;
    }
    if (!group.vendor) {
      setNotice(`fleet: ${group.adapter} has no vendor declaration — classification cannot be saved`);
      return;
    }
    pending.vendor = group.vendor;
    const answered = channelByAdapterRef.current[group.adapter];
    if (answered) {
      pending.channel = answered;
      pendingClassificationRef.current = pending;
      showScreen("tiers");
      return;
    }
    pendingClassificationRef.current = pending;
    channelCursorRef.current = 0;
    setChannelCursor(0);
    setNotice("");
    showScreen("channel");
  };

  useInput((input, key) => {
    if (doneRef.current) return;
    if (key.escape && (screenRef.current === "candidates" || screenRef.current === "shape-prefer")) {
      showScreen("shapes");
      return;
    }
    if (key.escape && (screenRef.current === "steering-prefer" || screenRef.current === "judge-pick")) {
      showScreen("steering");
      return;
    }
    // The classification sub-flow (add-model → channel → tier → provenance) cancels back to the
    // models list — before this, provenance's own "esc cancel" legend lied: Esc fell through to
    // the walk-home branch in init entry and to QUIT in fleet entry, discarding staged work.
    if (key.escape && (screenRef.current === "add-model" || screenRef.current === "channel" || screenRef.current === "tiers" || screenRef.current === "provenance")) {
      noteRef.current = "";
      setNote("");
      setNotice("");
      pendingSuggestionRef.current = null;
      bulkRef.current = null;
      showScreen("models");
      return;
    }
    // v1.90.8 (operator field report): inside the init journey, one Esc must never discard the
    // whole walk — from any walk screen it returns HOME to the presets screen; Esc there (or
    // `q`/ctrl+c anywhere) remains the real quit. Sub-screen Escs above keep their tighter backs.
    if (key.escape && entry === "presets" && screenRef.current !== "modes") {
      setReview(null);
      presetPickRef.current = true;
      showScreen("modes");
      return;
    }
    // While a type-to-search filter is LIVE, every printable char belongs to the search box:
    // the letter aliases (j/k navigation, q quit, models' t/n/a) go dormant so "fake-n" or
    // "qwen" can actually be typed — the k moved the cursor and the q quit the editor before
    // this (operator field session, 2026-08-13). Arrows, Enter, Space, and Esc keep their roles.
    const letterAlias = filterRef.current === "" ? input : "";
    const typing = screenRef.current === "provenance" || screenRef.current === "add-model";
    if (key.escape || (!typing && letterAlias === "q") || (key.ctrl && input === "c")) {
      finish({ kind: "quit" });
      return;
    }

    if (screenRef.current === "probe") {
      if (letterAlias === "r") {
        finish({ kind: "refresh" });
      } else if (key.return) {
        showScreen("agents");
      }
      return;
    }

    if (screenRef.current === "agents") {
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(cursorRef.current + 1, Math.max(agents.length - 1, 0));
        cursorRef.current = next;
        setCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(cursorRef.current - 1, 0);
        cursorRef.current = next;
        setCursor(next);
        return;
      }
      if (input === " " && agents.length > 0) {
        const next = new Set(denyRef.current);
        const id = agents[cursorRef.current].id;
        if (next.has(id)) next.delete(id);
        else next.add(id);
        denyRef.current = next;
        setDenyAdapters(next);
        return;
      }
      if (key.return) {
        if (enabledModelGroups().length === 0) showScreen("modes");
        else showScreen("models");
      }
      return;
    }

    if (screenRef.current === "models") {
      const rows = filteredModelRows();
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(modelCursorRef.current + 1, Math.max(rows.length - 1, 0));
        modelCursorRef.current = next;
        setModelCursor(next);
        setNotice("");
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(modelCursorRef.current - 1, 0);
        modelCursorRef.current = next;
        setModelCursor(next);
        setNotice("");
        return;
      }
      const group = enabledModelGroups()[modelGroupRef.current];
      const row = rows[modelCursorRef.current];
      if (input === " " && group && row) {
        if (!row.tier) {
          // v1.90.9 (operator field report: "not selectable"): an unclassified model has no tier
          // to route on — selecting IS classifying, so Space opens the same channel → tier →
          // provenance flow as `t` instead of dying silently on a row drawn like a checkbox.
          beginClassification(group, row.model);
          return;
        }
        const id = `${group.adapter}:${row.model}`;
        const next = new Set(denyModelsRef.current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        denyModelsRef.current = next;
        setDenyModels(next);
        return;
      }
      // Letter hotkeys yield to an ACTIVE search (letterAlias above): with a filter live, every
      // printable char belongs to the search box — otherwise typing "anthropic" toggles show-all
      // at the `a` and opens classify at the `t`.
      if (letterAlias === "t" && group && row) {
        if (row.tier) {
          setNotice("fleet: tier reassignment on classified models is not supported in v1 — edit config directly");
          return;
        }
        beginClassification(group, row.model);
        return;
      }
      if (letterAlias === "n" && group) {
        modelIdRef.current = "";
        setModelId("");
        setNotice("");
        showScreen("add-model");
        return;
      }
      if (letterAlias === "s" && group) {
        // OBS-508: bulk-stage every VISIBLE unclassified model carrying a catalog suggestion —
        // visible means the type-to-search filter and the retired-hide both scope the batch. The
        // staging is consent-preserving: it lands in the same classifications list the single
        // flow feeds, and only the review diff (y) ever writes.
        const suggested = filteredModelRows()
          .filter((candidate): candidate is { model: string; suggestion: FleetModelSuggestion } => !candidate.tier && candidate.suggestion !== undefined);
        if (!suggested.length) {
          setNotice("fleet: no catalog tier suggestions among the visible unclassified models — evidence comes from the cached catalogs (AA index / API pricing)");
          return;
        }
        const firstTouch = !group.rows.some((candidate) => candidate.tier !== undefined);
        if (!firstTouch) {
          stageSuggested(group, suggested);
          return;
        }
        if (!group.vendor) {
          setNotice(`fleet: ${group.adapter} has no vendor declaration — classification cannot be saved`);
          return;
        }
        const answered = channelByAdapterRef.current[group.adapter];
        if (answered) {
          stageSuggested(group, suggested, { vendor: group.vendor, channel: answered });
          return;
        }
        bulkRef.current = { group, rows: suggested };
        channelCursorRef.current = 0;
        setChannelCursor(0);
        setNotice("");
        showScreen("channel");
        return;
      }
      if (letterAlias === "a") {
        showAllModelsRef.current = !showAllModelsRef.current;
        setShowAllModels(showAllModelsRef.current);
        const clamped = Math.min(modelCursorRef.current, Math.max(filteredModelRows().length - 1, 0));
        modelCursorRef.current = clamped;
        setModelCursor(clamped);
        return;
      }
      if (key.return) {
        if (modelGroupRef.current + 1 < enabledModelGroups().length) {
          const next = modelGroupRef.current + 1;
          modelGroupRef.current = next;
          setModelGroup(next);
          modelCursorRef.current = 0;
          setModelCursor(0);
          filterRef.current = "";
          setFilter("");
        } else {
          showScreen("modes");
        }
        return;
      }
      if (filterInput((f) => filteredModelRows(f).length, modelCursorRef, setModelCursor, input, key)) {
        setNotice("");
      }
      return;
    }

    if (screenRef.current === "add-model") {
      if (key.return) {
        const group = enabledModelGroups()[modelGroupRef.current];
        const candidate = modelIdRef.current;
        if (!MODEL_ID_RE.test(candidate)) {
          setNotice(`fleet: model id must match ${MODEL_ID_RE.source}`);
          return;
        }
        if (currentModelRows().some((row) => row.model === candidate)) {
          setNotice(`fleet: ${candidate} is already listed for ${group?.adapter ?? "this adapter"}`);
          return;
        }
        if (group) beginClassification(group, candidate);
        return;
      }
      if (key.backspace || key.delete) {
        const next = modelIdRef.current.slice(0, -1);
        modelIdRef.current = next;
        setModelId(next);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const next = modelIdRef.current + input;
        modelIdRef.current = next;
        setModelId(next);
        setNotice("");
      }
      return;
    }

    if (screenRef.current === "channel") {
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(channelCursorRef.current + 1, CHANNELS.length - 1);
        channelCursorRef.current = next;
        setChannelCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(channelCursorRef.current - 1, 0);
        channelCursorRef.current = next;
        setChannelCursor(next);
        return;
      }
      if (key.return) {
        const channel = CHANNELS[channelCursorRef.current];
        // OBS-508: a bulk stage waiting on the one first-touch channel answer resumes here.
        const bulk = bulkRef.current;
        if (bulk?.group.vendor) {
          channelByAdapterRef.current[bulk.group.adapter] = channel;
          stageSuggested(bulk.group, bulk.rows, { vendor: bulk.group.vendor, channel });
          bulkRef.current = null;
          showScreen("models");
          return;
        }
        if (pendingClassificationRef.current) {
          channelByAdapterRef.current[pendingClassificationRef.current.adapter] = channel;
          pendingClassificationRef.current.channel = channel;
          showScreen("tiers");
        }
      }
      return;
    }

    if (screenRef.current === "tiers") {
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(tierCursorRef.current + 1, TIERS.length - 1);
        tierCursorRef.current = next;
        setTierCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(tierCursorRef.current - 1, 0);
        tierCursorRef.current = next;
        setTierCursor(next);
        return;
      }
      if (key.return && pendingClassificationRef.current) {
        const chosen = TIERS[tierCursorRef.current];
        pendingClassificationRef.current.tier = chosen;
        // OBS-508: keep the suggested band → the evidence note arrives pre-typed (Enter applies
        // it as-is); override the band → the note starts empty, because the suggestion's text
        // argues for a DIFFERENT tier than the one being recorded.
        const suggestion = pendingSuggestionRef.current;
        const prefill = suggestion && suggestion.tier === chosen ? suggestion.note : "";
        noteRef.current = prefill;
        setNote(prefill);
        setNotice("");
        showScreen("provenance");
      }
      return;
    }

    if (screenRef.current === "provenance") {
      if (key.return) {
        if (!noteRef.current.trim()) {
          setNotice("fleet: a typed benchmark-provenance note is required");
          return;
        }
        const pending = pendingClassificationRef.current;
        if (pending) {
          const next = [...classificationsRef.current, { ...pending, note: noteRef.current.trim() }];
          classificationsRef.current = next;
          setClassificationRevision((revision) => revision + 1);
        }
        pendingClassificationRef.current = null;
        pendingSuggestionRef.current = null;
        setNotice("");
        showScreen("models");
        return;
      }
      if (key.backspace || key.delete) {
        const next = noteRef.current.slice(0, -1);
        noteRef.current = next;
        setNote(next);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const next = noteRef.current + input;
        noteRef.current = next;
        setNote(next);
      }
    }

    if (screenRef.current === "modes") {
      // preset entry adds one final `custom` row after the modes — the full-walk escape hatch
      const rowCount = modeOptions.length + (presetPickRef.current ? 1 : 0);
      const currentModeCursor = modeCursorRef.current ?? 0;
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(currentModeCursor + 1, Math.max(rowCount - 1, 0));
        modeCursorRef.current = next;
        setModeCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(currentModeCursor - 1, 0);
        modeCursorRef.current = next;
        setModeCursor(next);
        return;
      }
      if (key.return) {
        if (presetPickRef.current && currentModeCursor === modeOptions.length) {
          presetPickRef.current = false;
          showScreen("agents");
          return;
        }
        if (!modeOptions[currentModeCursor]) return;
        selectedModeRef.current = modeOptions[currentModeCursor].id;
        if (presetPickRef.current) {
          // entry context: a preset pick goes straight to the diff confirm
          goReview();
          return;
        }
        showScreen("shapes");
      }
      return;
    }

    if (screenRef.current === "shapes") {
      const rows = shapeRows(selectedModeRef.current, stagedMap());
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(shapeCursorRef.current + 1, Math.max(rows.length - 1, 0));
        shapeCursorRef.current = next;
        setShapeCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(shapeCursorRef.current - 1, 0);
        shapeCursorRef.current = next;
        setShapeCursor(next);
        return;
      }
      const shape = rows[shapeCursorRef.current]?.id;
      if (letterAlias === "a" && shape) {
        const nextEntry = { ...stagedMap()[shape] };
        delete nextEntry.pin;
        const nextMap = { ...stagedMap(), [shape]: nextEntry };
        mapRef.current = nextMap;
        setMap(nextMap);
        return;
      }
      if (letterAlias === "p" && shape) {
        candidatesRef.current = candidatesForShape(shape, selectedModeRef.current, stagedMap());
        candidateCursorRef.current = 0;
        setCandidateCursor(0);
        showScreen("candidates");
        return;
      }
      if (letterAlias === "f" && shape) {
        const current = stagedMap()[shape]?.prefer ?? [];
        preferRowsRef.current = preferOptionsForShape(shape, current);
        preferChainRef.current = current.slice();
        preferCursorRef.current = 0;
        setPreferCursor(0);
        showScreen("shape-prefer");
        return;
      }
      if (key.return) finishEditor();
      return;
    }

    if (screenRef.current === "candidates") {
      const rows = filteredCandidates();
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(candidateCursorRef.current + 1, Math.max(rows.length - 1, 0));
        candidateCursorRef.current = next;
        setCandidateCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(candidateCursorRef.current - 1, 0);
        candidateCursorRef.current = next;
        setCandidateCursor(next);
        return;
      }
      if (key.return && rows[candidateCursorRef.current]) {
        const shape = shapeRows(selectedModeRef.current, stagedMap())[shapeCursorRef.current]?.id;
        if (shape) {
          const picked = rows[candidateCursorRef.current];
          const nextMap = { ...stagedMap(), [shape]: { pin: picked.pin } };
          mapRef.current = nextMap;
          setMap(nextMap);
        }
        showScreen("shapes");
        return;
      }
      filterInput((f) => filteredCandidates(f).length, candidateCursorRef, setCandidateCursor, input, key);
      return;
    }

    if (screenRef.current === "shape-prefer") {
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(preferCursorRef.current + 1, Math.max(preferRowsRef.current.length - 1, 0));
        preferCursorRef.current = next;
        setPreferCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(preferCursorRef.current - 1, 0);
        preferCursorRef.current = next;
        setPreferCursor(next);
        return;
      }
      if (input === " " && preferRowsRef.current[preferCursorRef.current]) {
        const option = preferRowsRef.current[preferCursorRef.current];
        const at = preferChainRef.current.indexOf(option);
        if (at === -1) preferChainRef.current.push(option);
        else preferChainRef.current.splice(at, 1);
        setPreferRevision((revision) => revision + 1);
        return;
      }
      if (key.return) {
        const shape = shapeRows(selectedModeRef.current, stagedMap())[shapeCursorRef.current]?.id;
        if (shape) {
          const nextEntry = { ...stagedMap()[shape] };
          if (preferChainRef.current.length) nextEntry.prefer = preferChainRef.current.slice();
          else delete nextEntry.prefer;
          const nextMap = { ...stagedMap(), [shape]: nextEntry };
          mapRef.current = nextMap;
          setMap(nextMap);
        }
        showScreen("shapes");
      }
      return;
    }

    if (screenRef.current === "steering") {
      // review.prefer + consult.prefer rows plus the single judge seat as the final row
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(steeringCursorRef.current + 1, STEERING_KEYS.length);
        steeringCursorRef.current = next;
        setSteeringCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(steeringCursorRef.current - 1, 0);
        steeringCursorRef.current = next;
        setSteeringCursor(next);
        return;
      }
      if (letterAlias === "f") {
        if (steeringCursorRef.current === STEERING_KEYS.length) {
          judgeCursorRef.current = 0;
          setJudgeCursor(0);
          setNotice("");
          showScreen("judge-pick");
          return;
        }
        const which = STEERING_KEYS[steeringCursorRef.current];
        const current = steeringRef.current?.[which] ?? [];
        steeringPickerRef.current = which;
        steeringRowsRef.current = steeringOptionsFor(which, current);
        steeringChainRef.current = current.slice();
        steeringPickerCursorRef.current = 0;
        setSteeringPickerCursor(0);
        setNotice("");
        showScreen("steering-prefer");
        return;
      }
      if (key.return) goReview();
      return;
    }

    if (screenRef.current === "judge-pick") {
      const rows = filteredJudgeRows();
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(judgeCursorRef.current + 1, Math.max(rows.length - 1, 0));
        judgeCursorRef.current = next;
        setJudgeCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(judgeCursorRef.current - 1, 0);
        judgeCursorRef.current = next;
        setJudgeCursor(next);
        return;
      }
      if (key.return && rows[judgeCursorRef.current]) {
        // single-select: one seat or back to the config default — never a chain
        const picked = rows[judgeCursorRef.current];
        const seat = picked === judgeKeepRow ? null : picked;
        judgeSeatRef.current = seat;
        setJudgeSeat(seat);
        showScreen("steering");
        return;
      }
      filterInput((f) => filteredJudgeRows(f).length, judgeCursorRef, setJudgeCursor, input, key);
      return;
    }

    if (screenRef.current === "steering-prefer") {
      const rows = filteredSteeringRows();
      if (key.downArrow || letterAlias === "j") {
        const next = Math.min(
          steeringPickerCursorRef.current + 1,
          Math.max(rows.length - 1, 0),
        );
        steeringPickerCursorRef.current = next;
        setSteeringPickerCursor(next);
        return;
      }
      if (key.upArrow || letterAlias === "k") {
        const next = Math.max(steeringPickerCursorRef.current - 1, 0);
        steeringPickerCursorRef.current = next;
        setSteeringPickerCursor(next);
        return;
      }
      if (input === " " && rows[steeringPickerCursorRef.current]) {
        const option = rows[steeringPickerCursorRef.current];
        const at = steeringChainRef.current.indexOf(option);
        if (at === -1) steeringChainRef.current.push(option);
        else steeringChainRef.current.splice(at, 1);
        setSteeringPickerRevision((revision) => revision + 1);
        return;
      }
      if (key.return) {
        const which = steeringPickerRef.current;
        const next = {
          ...(steeringRef.current as Record<FleetSteeringKey, string[] | undefined>),
          [which]: steeringChainRef.current.length ? steeringChainRef.current.slice() : undefined,
        };
        steeringRef.current = next;
        setSteering(next);
        setNotice("");
        showScreen("steering");
        return;
      }
      filterInput((f) => filteredSteeringRows(f).length, steeringPickerCursorRef, setSteeringPickerCursor, input, key);
      return;
    }

    if (screenRef.current === "review") {
      if (input === "n") {
        finish({ kind: "discard" });
        return;
      }
      if (input === "y" && reviewRef.current) {
        const loadError = reloadGuard(reviewRef.current.after);
        if (loadError) {
          setNotice(`fleet: config loader rejects the proposed overlay — ${loadError}`);
          reviewRef.current = null;
          setReview(null);
          showScreen(presetPickRef.current ? "modes" : "steering");
          return;
        }
        finish({ kind: "write", review: reviewRef.current });
      }
    }
  });

  if (screen === "probe") {
    return (
      <FleetListScreen
        title="step 1/6 · probe data"
        legend="enter continue · r refresh via doctor · esc/q quit"
        rows={[{
          id: "doctor",
          content: <Text>{`probe data: ${formatDoctorAge(ageMs)} (.tickmarkr/doctor.json)`}</Text>,
        }]}
        cursor={0}
      />
    );
  }

  if (screen === "agents") {
    const rows: FleetListRow[] = agents.map((agent) => {
      const active = !denyAdapters.has(agent.id);
      return {
        id: agent.id,
        content: (
          <>
            <ToggleMark active={active} />
            <Text>{` ${agent.id}  ${agent.version}  ${agent.authed ? "authed" : "unauthed"}`}</Text>
          </>
        ),
      };
    });
    return (
      <FleetListScreen
        title="step 2/6 · agent CLIs"
        viewRows={viewRows}
        legend="↑↓/jk move · space toggle · enter next · esc/q quit"
        rows={rows}
        cursor={cursor}
      />
    );
  }

  const group = enabledModelGroups()[modelGroup];
  if (screen === "models") {
    const filtered = filteredModelRows();
    const rows: FleetListRow[] = filtered.map((row) => {
      const denied = group ? denyModels.has(`${group.adapter}:${row.model}`) : false;
      return {
        id: row.model,
        content: row.tier ? (
          <>
            <ToggleMark active={!denied} />
            <Text>{` ${row.model}  ${row.tier}  ${denied ? "denied" : "allowed"}`}</Text>
          </>
        ) : <Text>{`?  ${row.model}${row.suggestion ? `  → ${row.suggestion.tier} suggested` : ""}`}</Text>,
      };
    });
    // The remedy renders ONCE, for the row under the cursor — 218 identical "Space or t to
    // classify" suffixes drowned the model names and wrapped long ids (operator screenshot,
    // 2026-08-13). A notice always wins the line.
    const focused = filtered[modelCursor];
    const hidden = hiddenModelCount();
    const detail = [
      ...(notice
        ? [notice]
        : focused && !focused.tier
          ? [focused.suggestion
            ? `?  ${focused.suggestion.tier} suggested from catalog evidence — Space accepts prefilled, s stages every visible suggestion${focused.detectedAt ? ` (detected ${focused.detectedAt})` : ""}`
            : `?  unclassified — Space or t to classify${focused.detectedAt ? ` (detected ${focused.detectedAt})` : ""}; unclassified models are never routed`]
          : []),
      ...(hidden > 0 ? [`… ${hidden} retired/preview/non-worker hidden — a shows all`] : []),
      ...(showAllModelsRef.current ? ["showing retired models — a hides them again"] : []),
    ];
    return (
      <FleetListScreen
        title={`step 3/6 · models · ${group?.adapter ?? ""}`}
        legend="↑↓ move · Space toggle/classify · s stage suggested · t tier · n add · a all · Enter next · Type to search · Esc quit"
        viewRows={viewRows}
        rows={rows}
        cursor={modelCursor}
        details={detail}
        filter={filter}
      />
    );
  }

  if (screen === "add-model") return (
    <FleetListScreen
      title={`add model · ${group?.adapter ?? ""}`}
      legend="type model id · enter classify · esc cancel"
      rows={[{ id: "model", content: <Text>{modelId || "model id (required):"}</Text> }]}
      cursor={0}
      details={notice ? [notice] : []}
    />
  );

  if (screen === "channel") return (
    <FleetListScreen
      title={`channel · ${pendingClassificationRef.current?.adapter ?? ""}`}
      legend="↑↓/jk move · enter select · esc cancel · q quit"
      rows={CHANNELS.map((channel) => ({ id: channel, content: <Text>{channel}</Text> }))}
      cursor={channelCursor}
    />
  );

  if (screen === "tiers") {
    return (
      <FleetListScreen
        title={`pick · tier · ${pendingClassificationRef.current?.adapter}:${pendingClassificationRef.current?.model}`}
        legend="↑↓/jk move · enter select · esc cancel · q quit"
        rows={TIERS.map((tier) => ({ id: tier, content: <Text>{tier}</Text> }))}
        cursor={tierCursor}
      />
    );
  }

  if (screen === "provenance") return (
    <FleetListScreen
      title={`benchmark provenance · ${pendingClassificationRef.current?.adapter}:${pendingClassificationRef.current?.model}`}
      legend="type note · enter apply · esc cancel"
      rows={[{ id: "note", content: <Text>{note || "benchmark provenance note (required):"}</Text> }]}
      cursor={0}
      details={notice ? [notice] : []}
    />
  );

  if (screen === "modes") {
    const presetPick = presetPickRef.current;
    const rows: FleetListRow[] = modeOptions.map((option) => ({
      id: option.id,
      content: (
        <>
          {option.id === initialMode ? <ToggleMark active /> : <Text> </Text>}
          <Text>{` ${option.id.padEnd(11)}  ${option.gloss}`}</Text>
        </>
      ),
    }));
    if (presetPick) {
      rows.push({
        id: "custom",
        content: (
          <>
            <Text> </Text>
            <Text>{` ${"custom".padEnd(11)}  walk the full editor (agents → models → shapes → seats)`}</Text>
          </>
        ),
      });
    }
    return (
      <FleetListScreen
        title={presetPick ? "tickmarkr init · act 3 of 3 — fleet · routing presets" : "step 4/6 · routing mode"}
        legend={presetPick ? "↑↓ to move · Enter to apply preset · Enter on custom to walk the editor · Esc inside the walk returns here · Esc here closes" : "↑↓/jk move · enter select · esc/q quit"}
        rows={rows}
        cursor={modeCursor}
        details={modeOptions[modeCursor] ? modePreview(modeOptions[modeCursor].id, map) : []}
      />
    );
  }

  const renderedShapes = shapeRows(selectedModeRef.current, map);
  if (screen === "shapes") {
    return (
      <FleetListScreen
        title="step 5/6 · shape routing"
        legend="↑↓/jk move · a auto · p pin · f prefer · enter next · esc/q quit"
        rows={renderedShapes.map((row) => ({ id: row.id, content: <Text>{row.label}</Text> }))}
        cursor={shapeCursor}
      />
    );
  }

  const shape = renderedShapes[shapeCursor]?.id;
  if (screen === "candidates") {
    return (
      <FleetListScreen
        title={`pick · ${shape}`}
        viewRows={viewRows}
        legend="↑↓ to move · Enter to pin · Type to search · Esc to cancel · q to quit"
        rows={filteredCandidates().map((candidate) => ({
          id: candidate.id,
          content: <Text>{candidate.label}</Text>,
        }))}
        cursor={candidateCursor}
        filter={filter}
      />
    );
  }

  if (screen === "shape-prefer") return (
    <FleetListScreen
      title={`pick · ${shape}.prefer`}
      viewRows={viewRows}
      legend="↑↓/jk move · space add/drop · enter apply (empty clears) · esc cancel · q quit"
      rows={preferRowsRef.current.map((option) => {
        const at = preferChainRef.current.indexOf(option);
        return { id: option, content: <Text>{`${at === -1 ? "·" : String(at + 1)} ${option}`}</Text> };
      })}
      cursor={preferCursor}
    />
  );

  if (screen === "steering") {
    return (
      <FleetListScreen
        title="step 6/6 · steering"
        legend="↑↓ to move · f to edit · Enter to review · Esc/q to quit"
        rows={[
          ...STEERING_KEYS.map((key): FleetListRow => ({
            id: key,
            content: <Text>{`${key}.prefer  →  ${steering[key]?.join(", ") ?? "(none)"}`}</Text>,
          })),
          {
            id: "judge",
            content: <Text>{`judge  →  ${judgeSeat ?? (initialJudge ? `${initialJudge} (default)` : "(default)")}`}</Text>,
          },
        ]}
        cursor={steeringCursor}
        details={notice ? [notice] : []}
      />
    );
  }

  if (screen === "judge-pick") {
    const selected = judgeSeat ?? judgeKeepRow;
    return (
      <FleetListScreen
        title="pick · judge"
        viewRows={viewRows}
        legend="↑↓ to move · Enter to select · Type to search · Esc to cancel · q to quit"
        rows={filteredJudgeRows().map((label) => ({
          id: label,
          content: (
            <>
              {label === selected ? <ToggleMark active /> : <Text> </Text>}
              <Text>{` ${label}`}</Text>
            </>
          ),
        }))}
        cursor={judgeCursor}
        filter={filter}
      />
    );
  }

  if (screen === "steering-prefer") {
    const which = steeringPickerRef.current;
    return (
      <FleetListScreen
        title={`pick · ${which}.prefer`}
        viewRows={viewRows}
        legend="↑↓ to move · Space to add/drop · Enter to apply (empty clears) · Type to search · Esc to cancel · q to quit"
        rows={filteredSteeringRows().map((option) => {
          const at = steeringChainRef.current.indexOf(option);
          return { id: option, content: <Text>{`${at === -1 ? "·" : String(at + 1)} ${option}`}</Text> };
        })}
        cursor={steeringPickerCursor}
        filter={filter}
      />
    );
  }

  return (
    <FleetReviewScreen
      title="review · overlay diff"
      legend="y write · n discard · esc/q quit"
      diff={review?.diff ?? ""}
    />
  );
}

export async function runFleetInkEditor({
  ageMs,
  adapters,
  health,
  initialDenyAdapters,
  initialDenyModels,
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
  entry = "probe",
  initialJudge = "",
  judgeSeats = [],
  initialInput = [],
  input,
  output,
  debug = false,
}: {
  ageMs: number | null;
  adapters: WorkerAdapter[];
  health: Record<string, AuthHealth>;
  initialDenyAdapters: string[];
  initialDenyModels: string[];
  modelGroups: FleetModelGroup[];
  initialMode: RoutingMode;
  modeOptions: FleetModeOption[];
  initialMap: Record<string, MapEntry>;
  modePreview: (mode: RoutingMode, map: Record<string, MapEntry>) => string[];
  shapeRows: (mode: RoutingMode, map: Record<string, MapEntry>) => FleetShapeRow[];
  candidatesForShape: (
    shape: Shape,
    mode: RoutingMode,
    map: Record<string, MapEntry>,
  ) => FleetCandidateOption[];
  preferOptionsForShape: (shape: Shape, current: string[]) => string[];
  initialSteering: Record<FleetSteeringKey, string[] | undefined>;
  steeringOptionsFor: (which: FleetSteeringKey, current: string[]) => string[];
  reviewOverlay: (state: FleetEditorState) => FleetOverlayReview;
  reloadGuard: (bytes: string) => string | null;
  /** "presets" opens on the routing-mode screen with the extra custom row; default preserves the probe-first walk */
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
  const app = render(
    <FleetApp
      ageMs={ageMs}
      agents={agents}
      initialDenyAdapters={initialDenyAdapters}
      initialDenyModels={initialDenyModels}
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
      entry={entry}
      initialJudge={initialJudge}
      judgeSeats={judgeSeats}
      // v1.90.9: omp's 218-model list rendered taller than the terminal and scrolled the cursor
      // and chrome off-screen — cap every list to the terminal, minus title/legend/markers/details.
      viewRows={Math.max(8, (output.rows ?? 40) - 10)}
    />,
    {
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
    },
  );
  let result: FleetEditorResult | undefined;
  try {
    result = await app.waitUntilExit() as FleetEditorResult;
    return result;
  } finally {
    app.unmount();
    bridgedInput.stop();
  }
}
