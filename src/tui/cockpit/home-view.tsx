import { Box, useInput } from "ink";
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { GLYPHS } from "../../brand.js";
import type {
  EvidenceIdentity,
  OperatorSnapshot,
  OperatorTask,
} from "../../run/operator-state.js";
import {
  BodyText,
  CockpitGrid,
  Panel,
  ProgressMeter,
  Sparkline,
  StateGlyph,
  type ComponentState,
} from "./components.js";
import { ABSENT_FIELD, fieldReading } from "./derive.js";

/** Rows visible in the ACTIVITY panel at once; PageUp/PageDown move the window by this many. */
export const HOME_ACTIVITY_VISIBLE_ROWS = 3;

export interface HomeSeats {
  /** Currently dispatched/running workers — a graph-backed fact, not a config count. */
  readonly active: number;
  /** Configured worker-eligible channels. Kept apart from `active`: neither is derivable from the other. */
  readonly eligible: number;
}

export interface HomeSpend {
  readonly measurable: boolean;
  /** Ignored unless `measurable`: a caller must not smuggle a `$0` display past an unmeasurable flag. */
  readonly display?: string;
}

export interface HomeActivityRow {
  /** The original journal line this row draws — never a filtered/on-screen ordinal. */
  readonly evidence: EvidenceIdentity;
  readonly time: string;
  readonly state: ComponentState;
  readonly text: string;
}

export interface HomeNeedsYouTarget {
  readonly kind: "park" | "diagnostic";
  readonly id: string;
  readonly label: string;
}

export interface HomeViewInput {
  readonly operator: OperatorSnapshot;
  readonly seats: HomeSeats;
  readonly spend?: HomeSpend;
  /** Sparkline samples for the MERGED tile; absent/all-null renders "no history", never a blank ramp. */
  readonly trend?: readonly (number | null)[];
  readonly activity?: readonly HomeActivityRow[];
  /** Available diagnostic targets Needs-you may offer when no park is open (e.g. a lock/read issue). */
  readonly diagnostics?: readonly HomeNeedsYouTarget[];
}

export interface HomeViewModel {
  readonly hasRun: boolean;
  readonly lifecycle: OperatorSnapshot["lifecycle"];
  readonly label: string;
  readonly green: boolean;
  readonly comparable: boolean;
  readonly merged: number;
  readonly planned?: number;
  /** A comparable graph with zero tasks: distinct from "not comparable" and from 100%. */
  readonly noPlan: boolean;
  readonly trend: readonly (number | null)[];
  readonly gatesRan: { readonly passed: number; readonly total: number };
  readonly gatePassRate?: number;
  readonly currentTip: OperatorSnapshot["currentTip"];
  readonly buckets: OperatorSnapshot["buckets"];
  readonly seats: HomeSeats;
  readonly spend: HomeSpend;
  readonly humanCount: number;
  readonly blockedCount: number;
  readonly needsYou: readonly HomeNeedsYouTarget[];
  readonly activity: readonly HomeActivityRow[];
  readonly runningTask?: OperatorTask;
  readonly progressPercent?: number;
  readonly progressCaption: string;
}

const parkLabel = (task: OperatorTask): string =>
  `${task.id} ${task.parkKind ?? task.state}`;

/**
 * Pure C2-to-Home mapping. Needs-you reads LIVE task state (not the closed
 * run's buckets, which the fold clears on resume) so a park stays actionable
 * for an active/resumed run, not only a finished one.
 */
export function deriveHomeView(input: HomeViewInput): HomeViewModel {
  const { operator } = input;
  const hasRun = operator.lifecycle !== "UNKNOWN";
  const humanTasks = operator.tasks.filter((t) => t.state === "human");
  const blockedTasks = operator.tasks.filter((t) => t.state === "blocked");
  const parks: HomeNeedsYouTarget[] = [...humanTasks, ...blockedTasks].map((t) => ({
    kind: "park" as const,
    id: t.id,
    label: parkLabel(t),
  }));
  const diagnostics = (input.diagnostics ?? []).filter((d) => d.id.trim().length > 0);
  const needsYou = [...parks, ...diagnostics];
  const planned = operator.comparable ? operator.planned : undefined;
  const noPlan = operator.comparable && planned === 0;
  const gatePassRate = operator.gatesRan.total > 0
    ? Math.round((operator.gatesRan.passed / operator.gatesRan.total) * 100)
    : undefined;
  const runningTask = operator.tasks.find((t) => t.state === "running");
  const progressPercent = planned && planned > 0
    ? Math.round((operator.merged / planned) * 100)
    : undefined;
  const progressCaption = !hasRun
    ? ""
    : noPlan
    ? "no plan"
    : !operator.comparable
    ? "not comparable"
    : `worker ${fieldReading(runningTask?.id)} | attempt ${fieldReading(runningTask?.attempt)}`;
  return {
    hasRun,
    lifecycle: operator.lifecycle,
    label: operator.label,
    green: operator.green,
    comparable: operator.comparable,
    merged: operator.merged,
    planned,
    noPlan,
    trend: input.trend ?? [],
    gatesRan: operator.gatesRan,
    gatePassRate,
    currentTip: operator.currentTip,
    buckets: operator.buckets,
    seats: input.seats,
    // A caller marking spend unmeasurable may still carry a stale `display`; discard it so an
    // all-subscription/no-telemetry fixture can never surface as a measured $0.
    spend: input.spend?.measurable ? input.spend : { measurable: false },
    humanCount: humanTasks.length,
    blockedCount: blockedTasks.length,
    needsYou,
    activity: input.activity ?? [],
    runningTask,
    progressPercent,
    progressCaption,
  };
}

/** The park/diagnostic Needs-you would open right now, or undefined when nothing needs the operator. */
export function selectNeedsYouTarget(model: HomeViewModel, index = 0): HomeNeedsYouTarget | undefined {
  if (model.needsYou.length === 0) return undefined;
  const safeIndex = Math.min(Math.max(0, index), model.needsYou.length - 1);
  return model.needsYou[safeIndex];
}

/** The original evidence a given activity row opens, however far outside the visible window it sits. */
export function selectActivityTarget(model: HomeViewModel, index: number): EvidenceIdentity | undefined {
  return model.activity[index]?.evidence;
}

const hasTrend = (trend: readonly (number | null)[]): boolean =>
  trend.some((sample) => typeof sample === "number");

function Tile({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <Panel title={label} flexGrow={1}>{children}</Panel>;
}

export interface HomeViewProps {
  readonly model: HomeViewModel;
  readonly width?: number | string;
  /** Whether Home currently owns local input; a shell showing another view passes false. */
  readonly focused?: boolean;
  readonly onOpenPark: (taskId: string) => void;
  readonly onOpenDiagnostic: (id: string) => void;
  readonly onOpenEvidence: (evidence: EvidenceIdentity) => void;
  readonly onSelectNeedsYou?: (target: HomeNeedsYouTarget | undefined, index: number) => void;
}

/** The exported Home body: C1 mounts this against a live HomeViewModel and its own navigation callbacks. */
export function HomeView({
  model,
  width,
  focused = true,
  onOpenPark,
  onOpenDiagnostic,
  onOpenEvidence,
  onSelectNeedsYou,
}: HomeViewProps): ReactElement {
  const [offset, setOffset] = useState(0);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | undefined>(
    () => model.activity[0]?.evidence.id,
  );
  const [activityIndex, setActivityIndex] = useState(0);
  const [selectedNeedsYouId, setSelectedNeedsYouId] = useState<string | undefined>(
    () => model.needsYou[0]?.id,
  );
  const [needsYouIndex, setNeedsYouIndex] = useState(0);
  const [section, setSection] = useState<"needsYou" | "activity">(
    model.needsYou.length > 0 ? "needsYou" : "activity",
  );

  // Reconcile Needs-you selection against model updates by stable target id.
  let effectiveNeedsYouIndex = 0;
  if (model.needsYou.length > 0) {
    const found = selectedNeedsYouId !== undefined
      ? model.needsYou.findIndex((t) => t.id === selectedNeedsYouId)
      : -1;
    if (found >= 0) {
      effectiveNeedsYouIndex = found;
    } else {
      effectiveNeedsYouIndex = Math.min(Math.max(0, needsYouIndex), model.needsYou.length - 1);
    }
  }
  const selectedNeedsYou = selectNeedsYouTarget(model, effectiveNeedsYouIndex);

  // Reconcile Activity selection against model updates by stable evidence id.
  let effectiveActivityIndex = 0;
  if (model.activity.length > 0) {
    const found = selectedEvidenceId !== undefined
      ? model.activity.findIndex((r) => r.evidence.id === selectedEvidenceId)
      : -1;
    if (found >= 0) {
      effectiveActivityIndex = found;
    } else {
      effectiveActivityIndex = Math.min(Math.max(0, activityIndex), model.activity.length - 1);
    }
  }

  useLayoutEffect(() => {
    if (model.needsYou.length > 0) {
      const currentTargetId = model.needsYou[effectiveNeedsYouIndex]?.id;
      if (currentTargetId !== selectedNeedsYouId) {
        setSelectedNeedsYouId(currentTargetId);
      }
      if (effectiveNeedsYouIndex !== needsYouIndex) {
        setNeedsYouIndex(effectiveNeedsYouIndex);
      }
    }
    onSelectNeedsYou?.(selectedNeedsYou, effectiveNeedsYouIndex);
  }, [selectedNeedsYou?.id, effectiveNeedsYouIndex, onSelectNeedsYou]);

  useLayoutEffect(() => {
    if (model.activity.length > 0) {
      const currentEvidenceId = model.activity[effectiveActivityIndex]?.evidence.id;
      if (currentEvidenceId !== selectedEvidenceId) {
        setSelectedEvidenceId(currentEvidenceId);
      }
      if (effectiveActivityIndex !== activityIndex) {
        setActivityIndex(effectiveActivityIndex);
      }
    }
  }, [model.activity, effectiveActivityIndex]);

  const effectiveSection = model.needsYou.length > 0 ? section : "activity";
  // The offset can reach the very last row (a short final page), not just the last full window —
  // otherwise the oldest row could never become the one Enter opens.
  const maxOffset = Math.max(0, model.activity.length - 1);
  const maxSelection = Math.max(0, model.activity.length - 1);
  const safeOffset = Math.min(offset, maxOffset);

  // Keep input ahead of the next render/effect subscription, as in EvidenceView.
  // Render reconciles the refs with model updates; each move writes before setting state.
  const sectionRef = useRef(effectiveSection);
  const needsYouIndexRef = useRef(effectiveNeedsYouIndex);
  const activityIndexRef = useRef(effectiveActivityIndex);
  sectionRef.current = effectiveSection;
  needsYouIndexRef.current = effectiveNeedsYouIndex;
  activityIndexRef.current = effectiveActivityIndex;
  const moveSection = (next: "needsYou" | "activity"): void => {
    sectionRef.current = next;
    setSection(next);
  };
  const moveNeedsYou = (index: number): void => {
    needsYouIndexRef.current = index;
    setNeedsYouIndex(index);
    setSelectedNeedsYouId(model.needsYou[index]?.id);
  };
  const moveActivity = (index: number): void => {
    activityIndexRef.current = index;
    setActivityIndex(index);
    setSelectedEvidenceId(model.activity[index]?.evidence.id);
  };

  useInput(
    (_input, key) => {
      if (key.leftArrow && model.needsYou.length > 0) {
        if (sectionRef.current === "needsYou") {
          const nextIndex = (needsYouIndexRef.current + 1) % model.needsYou.length;
          moveNeedsYou(nextIndex);
        } else {
          moveSection("needsYou");
        }
      }
      if (key.rightArrow) moveSection("activity");
      if (key.upArrow) {
        if (sectionRef.current === "needsYou") {
          if (model.needsYou.length > 0) {
            const nextIndex = (needsYouIndexRef.current - 1 + model.needsYou.length) % model.needsYou.length;
            moveNeedsYou(nextIndex);
          }
        } else {
          if (model.activity.length > 0) {
            const nextIndex = Math.max(0, activityIndexRef.current - 1);
            moveActivity(nextIndex);
          }
        }
      }
      if (key.downArrow) {
        if (sectionRef.current === "needsYou") {
          if (model.needsYou.length > 0) {
            const nextIndex = (needsYouIndexRef.current + 1) % model.needsYou.length;
            moveNeedsYou(nextIndex);
          }
        } else {
          if (model.activity.length > 0) {
            const nextIndex = Math.min(maxSelection, activityIndexRef.current + 1);
            moveActivity(nextIndex);
          }
        }
      }
      if (key.pageDown) {
        setOffset((o) => Math.max(0, o - HOME_ACTIVITY_VISIBLE_ROWS));
        if (model.activity.length > 0) {
          const nextIndex = Math.max(0, activityIndexRef.current - HOME_ACTIVITY_VISIBLE_ROWS);
          moveActivity(nextIndex);
        }
      }
      if (key.pageUp) {
        setOffset((o) => Math.min(maxOffset, o + HOME_ACTIVITY_VISIBLE_ROWS));
        if (model.activity.length > 0) {
          const nextIndex = Math.min(maxSelection, activityIndexRef.current + HOME_ACTIVITY_VISIBLE_ROWS);
          moveActivity(nextIndex);
        }
      }
      if (key.return) {
        if (sectionRef.current === "needsYou") {
          const target = selectNeedsYouTarget(model, needsYouIndexRef.current);
          if (target) (target.kind === "park" ? onOpenPark : onOpenDiagnostic)(target.id);
        } else {
          const row = model.activity[activityIndexRef.current];
          if (row) onOpenEvidence(row.evidence);
        }
      }
    },
    { isActive: focused },
  );

  if (!model.hasRun) {
    return (
      <Panel title="HOME" width={width}>
        <BodyText>No run recorded yet.</BodyText>
        <BodyText>tickmarkr fleet — review installed models</BodyText>
        <BodyText>tickmarkr plan — preview routing for a spec</BodyText>
      </Panel>
    );
  }

  const mergedValue = model.noPlan ? "no plan" : `${model.merged} / ${fieldReading(model.planned)}`;
  const gatePassRateValue = model.gatePassRate === undefined ? "no history" : `${model.gatePassRate}%`;
  const spendValue = model.spend.measurable ? model.spend.display ?? ABSENT_FIELD : "not measurable";
  const visibleActivity = model.activity.slice(safeOffset, safeOffset + HOME_ACTIVITY_VISIBLE_ROWS);

  return (
    <Box flexDirection="column" width={width}>
      <BodyText emphasis="strong">HOME / {model.lifecycle}</BodyText>
      <CockpitGrid>
        <Tile label="MERGED">
          <BodyText emphasis="strong">{mergedValue}</BodyText>
          {hasTrend(model.trend)
            ? <Sparkline samples={model.trend} />
            : <BodyText emphasis="dim">no history</BodyText>}
        </Tile>
        <Tile label="GATES RAN (historical)">
          <BodyText emphasis="strong">{model.gatesRan.passed} / {model.gatesRan.total}</BodyText>
        </Tile>
        <Tile label="GATE PASS RATE (historical)">
          <BodyText emphasis="strong">{gatePassRateValue}</BodyText>
        </Tile>
      </CockpitGrid>
      <CockpitGrid>
        <Tile label="ACTIVE SEATS">
          <BodyText emphasis="strong">{model.seats.active} active</BodyText>
          <BodyText emphasis="dim">{model.seats.eligible} eligible channels</BodyText>
        </Tile>
        <Tile label="NEEDS YOU">
          <BodyText emphasis={effectiveSection === "needsYou" ? "strong" : "normal"}>
            {model.humanCount} parks; {model.blockedCount} blocked
          </BodyText>
          {selectedNeedsYou && <BodyText emphasis="dim">{selectedNeedsYou.label}</BodyText>}
        </Tile>
        <Tile label="SPEND">
          <BodyText emphasis="strong">{spendValue}</BodyText>
        </Tile>
      </CockpitGrid>
      <Panel title="PROGRESS">
        {model.progressPercent === undefined
          ? <BodyText>{model.progressCaption}</BodyText>
          : (
            <>
              <ProgressMeter value={model.progressPercent} />
              <BodyText emphasis="dim">{model.progressCaption}</BodyText>
            </>
          )}
        <BodyText>CURRENT TIP: {model.currentTip.toUpperCase()}</BodyText>
      </Panel>
      <Panel title="ACTIVITY" focused={effectiveSection === "activity"}>
        {visibleActivity.length === 0
          ? <BodyText emphasis="dim">no history</BodyText>
          : visibleActivity.map((row, index) => {
            const isSelected = effectiveSection === "activity" && (safeOffset + index === effectiveActivityIndex);
            return (
              <Box key={row.evidence.id} flexDirection="row">
                <BodyText emphasis="dim">{row.time}</BodyText>
                <BodyText> </BodyText>
                <StateGlyph state={row.state} />
                <BodyText> {isSelected ? `${GLYPHS.pointer} ` : ""}{row.text}</BodyText>
              </Box>
            );
          })}
        <BodyText emphasis="dim">PageUp history | Enter opens original journal line</BodyText>
      </Panel>
    </Box>
  );
}
