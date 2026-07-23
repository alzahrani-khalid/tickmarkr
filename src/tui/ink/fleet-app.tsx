import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { render, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import type { AuthHealth, WorkerAdapter } from "../../adapters/types.js";
import type { MapEntry, RoutingMode, Tier } from "../../config/config.js";
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

export type FleetModelGroup = {
  adapter: string;
  rows: Array<{ model: string; tier?: Tier; detectedAt?: string }>;
};

export type FleetClassification = {
  adapter: string;
  model: string;
  tier: Tier;
  note: string;
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
}) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<
    | "probe"
    | "agents"
    | "models"
    | "tiers"
    | "provenance"
    | "modes"
    | "shapes"
    | "candidates"
    | "shape-prefer"
    | "steering"
    | "steering-prefer"
    | "review"
  >("probe");
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
  const tierCursorRef = useRef(0);
  const [tierCursor, setTierCursor] = useState(0);
  const pendingClassificationRef = useRef<Omit<FleetClassification, "note"> | null>(null);
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
  const reviewRef = useRef<Extract<FleetOverlayReview, { kind: "diff" }> | null>(null);
  const [review, setReview] = useState<Extract<FleetOverlayReview, { kind: "diff" }> | null>(null);
  const doneRef = useRef(false);

  const enabledModelGroups = () => modelGroups.filter((group) => !denyRef.current?.has(group.adapter));
  const stagedMap = () => mapRef.current as Record<string, MapEntry>;
  const currentModelRows = () => {
    const group = enabledModelGroups()[modelGroupRef.current];
    if (!group) return [];
    return group.rows.map((row) => {
      const staged = classificationsRef.current.find(
        (classification) => classification.adapter === group.adapter && classification.model === row.model,
      );
      return staged ? { ...row, tier: staged.tier } : row;
    });
  };

  const editorState = (): FleetEditorState => ({
    denyAdapters: [...(denyRef.current ?? [])].sort(),
    denyModels: [...(denyModelsRef.current ?? [])].sort(),
    classifications: classificationsRef.current,
    selectedMode: selectedModeRef.current,
    map: stagedMap(),
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
    screenRef.current = next;
    setScreen(next);
  };

  useInput((input, key) => {
    if (doneRef.current) return;
    if (key.escape && (screenRef.current === "candidates" || screenRef.current === "shape-prefer")) {
      showScreen("shapes");
      return;
    }
    if (key.escape && screenRef.current === "steering-prefer") {
      showScreen("steering");
      return;
    }
    if (key.escape || (screenRef.current !== "provenance" && input === "q") || (key.ctrl && input === "c")) {
      finish({ kind: "quit" });
      return;
    }

    if (screenRef.current === "probe") {
      if (input === "r") {
        finish({ kind: "refresh" });
      } else if (key.return) {
        showScreen("agents");
      }
      return;
    }

    if (screenRef.current === "agents") {
      if (key.downArrow || input === "j") {
        const next = Math.min(cursorRef.current + 1, Math.max(agents.length - 1, 0));
        cursorRef.current = next;
        setCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
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
      const rows = currentModelRows();
      if (key.downArrow || input === "j") {
        const next = Math.min(modelCursorRef.current + 1, Math.max(rows.length - 1, 0));
        modelCursorRef.current = next;
        setModelCursor(next);
        setNotice("");
        return;
      }
      if (key.upArrow || input === "k") {
        const next = Math.max(modelCursorRef.current - 1, 0);
        modelCursorRef.current = next;
        setModelCursor(next);
        setNotice("");
        return;
      }
      const group = enabledModelGroups()[modelGroupRef.current];
      const row = rows[modelCursorRef.current];
      if (input === " " && group && row?.tier) {
        const id = `${group.adapter}:${row.model}`;
        const next = new Set(denyModelsRef.current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        denyModelsRef.current = next;
        setDenyModels(next);
        return;
      }
      if (input === "t" && group && row) {
        if (row.tier) {
          setNotice("fleet: tier reassignment on classified models is not supported in v1 — edit config directly");
          return;
        }
        tierCursorRef.current = 0;
        setTierCursor(0);
        pendingClassificationRef.current = {
          adapter: group.adapter,
          model: row.model,
          tier: TIERS[0],
        };
        showScreen("tiers");
        return;
      }
      if (key.return) {
        if (modelGroupRef.current + 1 < enabledModelGroups().length) {
          const next = modelGroupRef.current + 1;
          modelGroupRef.current = next;
          setModelGroup(next);
          modelCursorRef.current = 0;
          setModelCursor(0);
        } else {
          showScreen("modes");
        }
      }
      return;
    }

    if (screenRef.current === "tiers") {
      if (key.downArrow || input === "j") {
        const next = Math.min(tierCursorRef.current + 1, TIERS.length - 1);
        tierCursorRef.current = next;
        setTierCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
        const next = Math.max(tierCursorRef.current - 1, 0);
        tierCursorRef.current = next;
        setTierCursor(next);
        return;
      }
      if (key.return && pendingClassificationRef.current) {
        pendingClassificationRef.current.tier = TIERS[tierCursorRef.current];
        noteRef.current = "";
        setNote("");
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
      const currentModeCursor = modeCursorRef.current ?? 0;
      if (key.downArrow || input === "j") {
        const next = Math.min(currentModeCursor + 1, Math.max(modeOptions.length - 1, 0));
        modeCursorRef.current = next;
        setModeCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
        const next = Math.max(currentModeCursor - 1, 0);
        modeCursorRef.current = next;
        setModeCursor(next);
        return;
      }
      if (key.return && modeOptions[currentModeCursor]) {
        selectedModeRef.current = modeOptions[currentModeCursor].id;
        showScreen("shapes");
      }
      return;
    }

    if (screenRef.current === "shapes") {
      const rows = shapeRows(selectedModeRef.current, stagedMap());
      if (key.downArrow || input === "j") {
        const next = Math.min(shapeCursorRef.current + 1, Math.max(rows.length - 1, 0));
        shapeCursorRef.current = next;
        setShapeCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
        const next = Math.max(shapeCursorRef.current - 1, 0);
        shapeCursorRef.current = next;
        setShapeCursor(next);
        return;
      }
      const shape = rows[shapeCursorRef.current]?.id;
      if (input === "a" && shape) {
        const nextEntry = { ...stagedMap()[shape] };
        delete nextEntry.pin;
        const nextMap = { ...stagedMap(), [shape]: nextEntry };
        mapRef.current = nextMap;
        setMap(nextMap);
        return;
      }
      if (input === "p" && shape) {
        candidatesRef.current = candidatesForShape(shape, selectedModeRef.current, stagedMap());
        candidateCursorRef.current = 0;
        setCandidateCursor(0);
        showScreen("candidates");
        return;
      }
      if (input === "f" && shape) {
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
      if (key.downArrow || input === "j") {
        const next = Math.min(candidateCursorRef.current + 1, Math.max(candidatesRef.current.length - 1, 0));
        candidateCursorRef.current = next;
        setCandidateCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
        const next = Math.max(candidateCursorRef.current - 1, 0);
        candidateCursorRef.current = next;
        setCandidateCursor(next);
        return;
      }
      if (key.return && candidatesRef.current[candidateCursorRef.current]) {
        const shape = shapeRows(selectedModeRef.current, stagedMap())[shapeCursorRef.current]?.id;
        if (shape) {
          const picked = candidatesRef.current[candidateCursorRef.current];
          const nextMap = { ...stagedMap(), [shape]: { pin: picked.pin } };
          mapRef.current = nextMap;
          setMap(nextMap);
        }
        showScreen("shapes");
      }
      return;
    }

    if (screenRef.current === "shape-prefer") {
      if (key.downArrow || input === "j") {
        const next = Math.min(preferCursorRef.current + 1, Math.max(preferRowsRef.current.length - 1, 0));
        preferCursorRef.current = next;
        setPreferCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
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
      if (key.downArrow || input === "j") {
        const next = Math.min(steeringCursorRef.current + 1, STEERING_KEYS.length - 1);
        steeringCursorRef.current = next;
        setSteeringCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
        const next = Math.max(steeringCursorRef.current - 1, 0);
        steeringCursorRef.current = next;
        setSteeringCursor(next);
        return;
      }
      if (input === "f") {
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
      if (key.return) {
        const nextReview = reviewOverlay(editorState());
        if (nextReview.kind === "empty") {
          finish({ kind: "no-changes" });
          return;
        }
        reviewRef.current = nextReview;
        setReview(nextReview);
        setNotice("");
        showScreen("review");
      }
      return;
    }

    if (screenRef.current === "steering-prefer") {
      if (key.downArrow || input === "j") {
        const next = Math.min(
          steeringPickerCursorRef.current + 1,
          Math.max(steeringRowsRef.current.length - 1, 0),
        );
        steeringPickerCursorRef.current = next;
        setSteeringPickerCursor(next);
        return;
      }
      if (key.upArrow || input === "k") {
        const next = Math.max(steeringPickerCursorRef.current - 1, 0);
        steeringPickerCursorRef.current = next;
        setSteeringPickerCursor(next);
        return;
      }
      if (input === " " && steeringRowsRef.current[steeringPickerCursorRef.current]) {
        const option = steeringRowsRef.current[steeringPickerCursorRef.current];
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
      }
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
          showScreen("steering");
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
        legend="↑↓/jk move · space toggle · enter next · esc/q quit"
        rows={rows}
        cursor={cursor}
      />
    );
  }

  const group = enabledModelGroups()[modelGroup];
  const modelRows = currentModelRows();
  if (screen === "models") {
    const rows: FleetListRow[] = modelRows.map((row) => {
      const denied = group ? denyModels.has(`${group.adapter}:${row.model}`) : false;
      return {
        id: row.model,
        content: row.tier ? (
          <>
            <ToggleMark active={!denied} />
            <Text>{` ${row.model}  ${row.tier}  ${denied ? "denied" : "allowed"}`}</Text>
          </>
        ) : <Text>{`( ) ${row.model}  ???  unclassified${row.detectedAt ? ` (${row.detectedAt})` : ""}`}</Text>,
      };
    });
    return (
      <FleetListScreen
        title={`step 3/6 · models · ${group?.adapter ?? ""}`}
        legend="↑↓/jk move · space toggle · t tier · enter next · esc/q quit"
        rows={rows}
        cursor={modelCursor}
        details={notice ? [notice] : []}
      />
    );
  }

  if (screen === "tiers") {
    return (
      <FleetListScreen
        title={`pick · tier · ${pendingClassificationRef.current?.adapter}:${pendingClassificationRef.current?.model}`}
        legend="↑↓/jk move · enter select · esc/q quit"
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
    return (
      <FleetListScreen
        title="step 4/6 · routing mode"
        legend="↑↓/jk move · enter select · esc/q quit"
        rows={modeOptions.map((option) => ({
          id: option.id,
          content: (
            <>
              {option.id === initialMode ? <ToggleMark active /> : <Text> </Text>}
              <Text>{` ${option.id.padEnd(11)}  ${option.gloss}`}</Text>
            </>
          ),
        }))}
        cursor={modeCursor}
        details={modePreview(modeOptions[modeCursor].id, map)}
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
        legend="↑↓/jk move · enter pin · esc cancel · q quit"
        rows={candidatesRef.current.map((candidate) => ({
          id: candidate.id,
          content: <Text>{candidate.label}</Text>,
        }))}
        cursor={candidateCursor}
      />
    );
  }

  if (screen === "shape-prefer") return (
    <FleetListScreen
      title={`pick · ${shape}.prefer`}
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
        legend="↑↓/jk move · f prefer · enter review · esc/q quit"
        rows={STEERING_KEYS.map((key) => ({
          id: key,
          content: <Text>{`${key}.prefer  →  ${steering[key]?.join(", ") ?? "(none)"}`}</Text>,
        }))}
        cursor={steeringCursor}
        details={notice ? [notice] : []}
      />
    );
  }

  if (screen === "steering-prefer") {
    const which = steeringPickerRef.current;
    return (
      <FleetListScreen
        title={`pick · ${which}.prefer`}
        legend="↑↓/jk move · space add/drop · enter apply (empty clears) · esc cancel · q quit"
        rows={steeringRowsRef.current.map((option) => {
          const at = steeringChainRef.current.indexOf(option);
          return { id: option, content: <Text>{`${at === -1 ? "·" : String(at + 1)} ${option}`}</Text> };
        })}
        cursor={steeringPickerCursor}
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
  const bridgedInput = inkInput(input, initialInput);
  const legacyOutput = typeof output.on !== "function" || typeof output.off !== "function";
  const app = render(
    <FleetApp
      ageMs={ageMs}
      agents={agents}
      initialDenyAdapters={initialDenyAdapters}
      initialDenyModels={initialDenyModels}
      modelGroups={modelGroups}
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
