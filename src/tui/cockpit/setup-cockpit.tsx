import { Box } from "ink";
import {
  cloneElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { parse } from "yaml";
import {
  BANNER,
  GLYPHS,
  PLAIN_BANNER,
} from "../../brand.js";
import {
  DEFAULT_CONFIG,
  INTEGRITY_FLOOR_SHAPES,
  TIER_RANK,
  TickmarkrConfigSchema,
  unifiedYamlDiff,
  type Tier,
  type TickmarkrConfig,
} from "../../config/config.js";
import { SHAPES } from "../../graph/schema.js";
import {
  allocateBandColumns,
  BandLines,
  BodyText,
  CockpitGrid,
  composeBandLine,
  JournalRowPanel,
  measureBandRows,
  Panel,
  StateGlyph,
  StatTile,
  StatusStrip,
  type BandColumnContent,
  type ComponentState,
  type JournalRow,
  type StatusStripItem,
} from "./components.js";
import type { DemoCaptures } from "./demo.js";
import {
  FULL_JOURNAL_ROWS,
  resolveCockpitLayout,
  type FrameCockpitLayout,
} from "./layout.js";
import {
  deriveRunCockpitData,
  PANEL_CHROME_ROWS,
  panelRows,
  wrappedRows,
} from "./run-cockpit.js";
import {
  initialSetupInteractionState,
  keybarEntries,
  SETUP_PANEL_FOCUS_ORDER,
  SURFACE_KEY_BINDINGS,
  type SetupInteractionState,
  type SetupKeyBinding,
} from "./keys.js";

export type SetupCockpitData = {
  readonly binaryVersion: string;
  readonly harnesses: readonly {
    readonly id: string;
    readonly version: string;
    readonly modelCount: number;
    readonly state: ComponentState;
    readonly stateWord: string;
  }[];
  readonly deniedChannels: readonly {
    readonly channel: string;
    readonly reason: string;
  }[];
  readonly counts: {
    readonly found: number;
    readonly authenticated: number;
    readonly routable: number;
  };
  readonly config: TickmarkrConfig;
  readonly overlayDiff: string;
  readonly stagedChanges: readonly string[];
  readonly reviewRows: readonly JournalRow[];
  readonly overlayTarget: string;
};

const APPROVED_SIDE_RAIL_COLUMN_FLOOR = 80;

const setupAdditionalBindings = (bindings: readonly SetupKeyBinding[]) =>
  bindings.filter((binding) =>
    !SURFACE_KEY_BINDINGS.run.some((runBinding) => runBinding.key === binding.key)
  );

type CapturedModelHealth = {
  readonly authed?: boolean;
  readonly reason?: string;
};

type CapturedHarnessHealth = {
  readonly installed?: boolean;
  readonly authed?: boolean;
  readonly version?: string;
  readonly models?: readonly string[];
  readonly modelAuth?: Readonly<Record<string, CapturedModelHealth>>;
};

function deepMerge<T>(base: T, overlay: unknown): T {
  if (overlay === undefined || overlay === null) return base;
  if (
    Array.isArray(base)
    || Array.isArray(overlay)
    || typeof base !== "object"
    || typeof overlay !== "object"
    || base === null
  ) {
    return overlay as T;
  }
  const merged: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = key in merged
      ? deepMerge(merged[key], value)
      : deepMerge({} as unknown, value);
  }
  return merged as T;
}

function floorEdits(layers: readonly unknown[]): {
  explicit: ReadonlySet<string>;
  tombstoned: ReadonlySet<string>;
} {
  const explicit = new Set<string>();
  const tombstoned = new Set<string>();
  for (const layer of layers) {
    const floors = (
      layer as { routing?: { floors?: Record<string, unknown> } } | undefined
    )?.routing?.floors;
    if (!floors || Array.isArray(floors)) continue;
    for (const [shape, value] of Object.entries(floors)) {
      if (value === null) {
        explicit.delete(shape);
        tombstoned.add(shape);
      } else {
        tombstoned.delete(shape);
        explicit.add(shape);
      }
    }
  }
  return { explicit, tombstoned };
}

function lowerTier(tier: Tier): Tier {
  return tier === "frontier" ? "mid" : "cheap";
}

function integrityMinimum(shape: string): Tier {
  return (INTEGRITY_FLOOR_SHAPES as readonly string[]).includes(shape)
    ? "frontier"
    : "cheap";
}

function presetFloor(
  mode: NonNullable<TickmarkrConfig["routing"]["mode"]>,
  shape: string,
  base: Tier,
): Tier {
  if (mode === "partner-led") return "frontier";
  if (mode === "risk-based") return base;
  const lowered = lowerTier(base);
  const minimum = integrityMinimum(shape);
  return TIER_RANK[lowered] >= TIER_RANK[minimum] ? lowered : minimum;
}

function resolveCapturedConfig(captures: DemoCaptures): TickmarkrConfig {
  const globalLayer = parse(captures.config.global.raw) as unknown;
  const repoLayer = parse(captures.config.repo.raw) as unknown;
  const parsed = TickmarkrConfigSchema.parse(
    deepMerge(
      deepMerge(structuredClone(DEFAULT_CONFIG), globalLayer),
      repoLayer,
    ),
  );
  const mode = parsed.routing.mode ?? "risk-based";
  const edits = floorEdits([globalLayer, repoLayer]);
  for (const shape of SHAPES) {
    if (edits.tombstoned.has(shape) || edits.explicit.has(shape)) continue;
    parsed.routing.floors[shape] = presetFloor(
      mode,
      shape,
      DEFAULT_CONFIG.routing.floors[shape],
    );
  }
  if (mode === "partner-led") {
    parsed.routing.explore = { ...parsed.routing.explore, mode: "off" };
  }
  return parsed;
}

function stagedPaths(value: unknown, path: readonly string[] = []): string[] {
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
  ) {
    return path.length > 0 ? [path.join(".")] : [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    stagedPaths(child, [...path, key])
  );
}

function deniedReason(reason: string | undefined): string {
  if (!reason) return "channel denied access";
  return reason.match(/Invalid params: "[^"]+"/)?.[0]
    ?? reason.split(/\.\s+Run\b/, 1)[0]!
    ?? reason;
}

export function deriveSetupCockpitData(
  captures: DemoCaptures,
  binaryVersion: string,
): SetupCockpitData {
  const harnessHealth = Object.entries(captures.doctor.data)
    .filter(([id]) => id !== "autoPrefer")
    .map(([id, raw]) => [id, raw as CapturedHarnessHealth] as const);
  const harnesses = harnessHealth.map(([id, health]) => {
    const models = new Set([
      ...(health.models ?? []),
      ...Object.keys(health.modelAuth ?? {}),
    ]);
    const state: ComponentState = health.installed !== true
      ? "inactive"
      : health.authed === true
        ? "pass"
        : "fail";
    return {
      id,
      version: health.version ?? "not installed",
      modelCount: models.size,
      state,
      stateWord: state === "pass" ? "authed"
        : state === "inactive" ? "missing"
          : "unauthed",
    };
  });
  const deniedChannels = harnessHealth.flatMap(([id, health]) =>
    Object.entries(health.modelAuth ?? {}).flatMap(([model, verdict]) =>
      verdict.authed === false
        ? [{
            channel: `${id}:${model}`,
            reason: deniedReason(verdict.reason),
          }]
        : []
    )
  );
  const authenticated = harnessHealth.filter(([, health]) =>
    health.installed === true && health.authed === true
  ).length;
  const routable = harnessHealth.filter(([, health]) =>
    health.installed === true
    && health.authed === true
    && Object.values(health.modelAuth ?? {}).some(
      (model) => model.authed === true,
    )
  ).length;
  const repoLayer = parse(captures.config.repo.raw) as unknown;
  const reviewSource = captures.journals.find(
    (capture) => capture.fileName === "run-20260724-231138.journal.jsonl",
  );
  if (!reviewSource) throw new Error("healthy cockpit capture is missing");

  return {
    binaryVersion,
    harnesses,
    deniedChannels,
    counts: {
      found: harnesses.length,
      authenticated,
      routable,
    },
    config: resolveCapturedConfig(captures),
    overlayDiff: unifiedYamlDiff(
      captures.config.global.raw,
      captures.config.repo.raw,
      captures.config.repo.fileName,
    ),
    stagedChanges: stagedPaths(repoLayer),
    reviewRows: deriveRunCockpitData(reviewSource, binaryVersion).journalRows,
    overlayTarget: captures.config.repo.fileName,
  };
}

function identityBannerLines(): readonly string[] {
  return (
    process.env.NO_COLOR === undefined ? BANNER : PLAIN_BANNER
  ).trimEnd().split("\n");
}

function identityVersionLines(
  data: SetupCockpitData,
  interaction?: SetupInteractionState,
): readonly string[] {
  return [
    `v${data.binaryVersion} · binary ${GLYPHS.pass}`,
    `setup · step ${interaction?.step ?? 2}/6`,
  ];
}

function IdentityHeader({
  data,
  secondary = true,
  interaction,
}: {
  data: SetupCockpitData;
  secondary?: boolean;
  interaction?: SetupInteractionState;
}): ReactElement {
  const mark = identityBannerLines();
  const [version, step] = identityVersionLines(data, interaction);
  return (
    <Box justifyContent="space-between">
      <Box flexDirection="column">
        {(secondary ? mark : mark.slice(0, 1)).map((line, index) => (
          <BodyText key={`${index}:${line}`} emphasis="strong">{line}</BodyText>
        ))}
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        <BodyText emphasis="strong">{version}</BodyText>
        {secondary && <BodyText>{step}</BodyText>}
      </Box>
    </Box>
  );
}

function NavigationPanel({
  width = 16,
  compact = false,
  step = 2,
  focused = false,
}: {
  width?: number;
  compact?: boolean;
  step?: number;
  focused?: boolean;
}): ReactElement {
  const entries = [
    "Detect",
    "Harnesses",
    "Fleet",
    "Gates",
    "Consults",
    "Reviewers",
    "Review",
  ] as const;
  if (!compact) {
    return (
      <Panel title="SETUP" width={width} focused={focused}>
        {entries.map((entry, index) => (
          <BodyText
            key={entry}
            emphasis={index + 1 === step ? "strong" : "normal"}
          >
            {index + 1 === step ? `${GLYPHS.pointer} ` : "  "}{entry}
          </BodyText>
        ))}
      </Panel>
    );
  }
  return (
    <Panel title="SETUP" width={width} focused={focused}>
      {entries.map((entry, index) => (
        <Box key={entry} height={1} overflow="hidden">
          <BodyText emphasis={index + 1 === step ? "strong" : "normal"}>
            {index + 1 === step ? `${GLYPHS.pointer} ` : "  "}{entry}
          </BodyText>
        </Box>
      ))}
    </Panel>
  );
}

function KeysPanel({
  bindings,
  width = 16,
  focused = false,
}: {
  bindings: readonly SetupKeyBinding[];
  width?: number;
  focused?: boolean;
}): ReactElement {
  return (
    <Panel title="KEYS" width={width} focused={focused}>
      {keybarEntries(bindings).map((item) => (
        <Box key={item.key}>
          <BodyText emphasis="strong">{item.key}</BodyText>
          <BodyText> {item.label}</BodyText>
        </Box>
      ))}
    </Panel>
  );
}

function CompactKeysPanel({
  bindings,
  width = 16,
  focused = false,
}: {
  bindings: readonly SetupKeyBinding[];
  width?: number;
  focused?: boolean;
}): ReactElement {
  const contentColumns = Math.max(1, width - 4);
  return (
    <Panel title="KEYS" width={width} focused={focused}>
      {keybarEntries(setupAdditionalBindings(bindings)).map((item) => (
        <Box
          key={item.key}
          flexDirection="row"
          flexWrap="nowrap"
          height={1}
          overflow="hidden"
        >
          <BodyText emphasis="strong">{item.key}</BodyText>
          <BodyText>
            {" "}{item.label.slice(
              0,
              Math.max(0, contentColumns - [...item.key].length - 1),
            )}
          </BodyText>
        </Box>
      ))}
    </Panel>
  );
}

function SetupKeybar({
  bindings,
  width,
}: {
  bindings: readonly SetupKeyBinding[];
  width: number;
}): ReactElement {
  return (
    <Box
      flexDirection="row"
      flexWrap="nowrap"
      width={width}
      height={1}
      overflow="hidden"
      aria-label="setup cockpit keys"
    >
      {keybarEntries(bindings).map((item, index) => (
        <Box key={item.key} flexShrink={0}>
          {index > 0 && <BodyText emphasis="dim"> · </BodyText>}
          <BodyText emphasis="strong">{item.key}</BodyText>
          <BodyText emphasis="dim"> {item.label}</BodyText>
        </Box>
      ))}
    </Box>
  );
}

function SetupInteractionPanel({
  data,
  interaction,
  bindings,
}: {
  data: SetupCockpitData;
  interaction?: SetupInteractionState;
  bindings: readonly SetupKeyBinding[];
}): ReactElement | null {
  if (interaction?.savePrompt === true) {
    return (
      <LinePanel
        title="SAVE"
        lines={["confirm save · y yes · n cancel", ...overlayDiffLines(data)]}
        columns={72}
      />
    );
  }
  if (interaction?.help === true) {
    return (
      <LinePanel
        title="HELP"
        lines={keybarEntries(bindings).map((item) => `${item.key} ${item.label}`)}
        columns={72}
      />
    );
  }
  return null;
}

function setupStatusItems(
  data: SetupCockpitData,
  interaction?: SetupInteractionState,
): readonly StatusStripItem[] {
  const items: StatusStripItem[] = [
    { state: "neutral", text: `overlay ${data.overlayTarget}` },
    { state: "pass", text: "base untouched" },
    interaction?.saved === true
      ? { state: "active", text: "changes saved" }
      : { state: "warn", text: `${data.stagedChanges.length} changes unsaved` },
  ];
  if (interaction !== undefined) {
    if (interaction.all) items.push({ state: "active", text: "all selected" });
    else if (interaction.selected.length > 0) {
      items.push({ state: "active", text: "selection selected" });
    } else if (interaction.selection >= 0) {
      items.push({ state: "neutral", text: `selection ${interaction.selection + 1}` });
    }
    if (interaction.probeRevision > 0) {
      items.push({ state: "pass", text: `re-probed ${interaction.probeRevision}` });
    }
    if (interaction.panel !== 1) {
      const panel = SETUP_PANEL_FOCUS_ORDER[interaction.panel] ?? "HARNESSES";
      items.push({ state: "neutral", text: `panel ${panel}` });
    }
  }
  return items;
}

function fullKeysFit(
  rows: number,
  layout: FrameCockpitLayout,
  data: SetupCockpitData,
  columns: number,
  bindings: readonly SetupKeyBinding[],
): boolean {
  if (!layout.elements.secondaryHeader) return false;
  const wrappedKeyRows = {
    "three-column": 0,
    "folded-keys": 2,
    stacked: 4,
  }[layout.arrangement];
  const panelRows = bindings.length
    + wrappedKeyRows
    + 3; // panel borders and title row
  return headerRowsFor(layout, data, columns) + 2 + panelRows <= Math.floor(rows);
}

function sidePanelWidth(layout: FrameCockpitLayout): number {
  if (layout.arrangement === "three-column") return 16;
  if (layout.arrangement === "folded-keys") return 12;
  return 11;
}

/**
 * Every detail panel publishes the body lines it draws, so the height ladder
 * can charge it the rows those very lines occupy rather than a constant that
 * goes stale the moment the panel changes.
 */
function detectedRows(data: SetupCockpitData): readonly {
  readonly key: string;
  readonly state: ComponentState;
  readonly text: string;
}[] {
  return [
    ...data.harnesses.map((harness) => ({
      key: harness.id,
      state: harness.state,
      text: ` ${harness.stateWord} · ${harness.id} · ${harness.version}`
        + ` · ${harness.modelCount} models`,
    })),
    ...data.deniedChannels.map((denied) => ({
      key: denied.channel,
      state: "fail" as ComponentState,
      text: ` denied · ${denied.channel} — ${denied.reason}`,
    })),
  ];
}

function fleetLines(data: SetupCockpitData): readonly string[] {
  const routing = data.config.routing;
  return [
    `mode ${routing.mode ?? "risk-based"}`,
    `floors ${
      Object.entries(routing.floors)
        .map(([shape, tier]) => `${shape}:${tier}`)
        .join(" · ")
    }`,
    `deny ${(routing.deny?.models ?? []).join(", ") || "none"}`,
  ];
}

function gatesLines(data: SetupCockpitData): readonly string[] {
  return [
    `test ${data.config.gates.test ?? "auto-detected"}`,
    `diff cap ${data.config.gates.diffCap}`,
  ];
}

function consultsLines(data: SetupCockpitData): readonly string[] {
  const consult = data.config.consult;
  return [
    `seat ${consult.adapter}:${consult.model}`,
    `stall ${consult.stallMinutes} minutes`,
    ...(consult.prefer ?? []).map((seat) => `prefer ${seat}`),
  ];
}

function reviewersLines(data: SetupCockpitData): readonly string[] {
  const review = data.config.review;
  return [
    `required ${String(review.required)}`,
    `complexity threshold ${review.complexityThreshold}`,
    ...(review.prefer ?? []).map((reviewer) => `prefer ${reviewer}`),
  ];
}

function overlayDiffLines(data: SetupCockpitData): readonly string[] {
  const lines = data.overlayDiff.split("\n");
  return [
    ...lines.slice(0, 2),
    ...lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).slice(0, 2),
    ...lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).slice(0, 4),
  ];
}

type DetectedRow = ReturnType<typeof detectedRows>[number];

function HarnessRows({
  rows,
  columns,
}: {
  rows: readonly DetectedRow[];
  columns: number;
}): ReactElement {
  return (
    <Panel title="DETECTED">
      {rows.flatMap((row) => {
        const [first = "", ...continuations] = composeBandLine(
          row.text.trimStart(),
          Math.max(1, columns),
        );
        return [
          <Box key={row.key}>
            <StateGlyph state={row.state} />
            <BodyText> {first}</BodyText>
          </Box>,
          ...continuations.map((line, index) => (
            <BodyText key={`${row.key}:continuation:${index}`}>{line}</BodyText>
          )),
        ];
      })}
    </Panel>
  );
}

function LinePanel({
  title,
  lines,
  columns,
  emphasis,
}: {
  title: string;
  lines: readonly string[];
  columns: number;
  emphasis?: "dim";
}): ReactElement {
  return (
    <Panel title={title}>
      <BandLines lines={lines} columns={columns} emphasis={emphasis} />
    </Panel>
  );
}

function lineBandContent(
  title: string,
  lines: readonly string[],
): BandColumnContent {
  return { title, lines };
}

function LineBand({
  columns,
  panels,
}: {
  columns: number;
  panels: readonly BandColumnContent[];
}): ReactElement {
  const widths = allocateBandColumns(columns, panels);
  return (
    <CockpitGrid columns={columns} columnContents={panels}>
      {panels.map((panel, index) => (
        <LinePanel
          key={panel.title}
          title={panel.title}
          lines={panel.lines}
          columns={Math.max(1, widths[index]! - 4)}
        />
      ))}
    </CockpitGrid>
  );
}

function statsSummaryLine(data: SetupCockpitData): string {
  return `found ${data.counts.found} · authenticated ${data.counts.authenticated}`
    + ` · routable ${data.counts.routable}`;
}

function SetupStats({
  data,
  mode,
}: {
  data: SetupCockpitData;
  mode: FrameCockpitLayout["stats"]["mode"];
}): ReactElement {
  if (mode === "summary") {
    return <BodyText>{statsSummaryLine(data)}</BodyText>;
  }
  return (
    <CockpitGrid>
      <StatTile
        label="FOUND"
        value={data.counts.found}
        samples={[data.counts.found]}
      />
      <StatTile
        label="AUTHENTICATED"
        value={data.counts.authenticated}
        samples={[data.counts.authenticated]}
      />
      <StatTile
        label="ROUTABLE"
        value={data.counts.routable}
        samples={[data.counts.routable]}
      />
    </CockpitGrid>
  );
}

function SizedReviewPanel({
  rows,
  bodyRows,
}: {
  rows: readonly JournalRow[];
  bodyRows: number;
}): ReactElement {
  const visible = rows.slice(0, bodyRows);
  const emptyRows = Math.max(0, bodyRows - visible.length);
  const review = JournalRowPanel({ rows: visible, title: "REVIEW" });
  const reviewProps = review.props as { readonly children?: ReactNode };
  return cloneElement(
    review,
    {},
    reviewProps.children,
    emptyRows > 0 ? <Box key="review-space" height={emptyRows} /> : null,
  );
}

/**
 * The contracted ladder (§5.4) governs the elements every surface shares. The
 * detail panels below it are the setup body, so they surrender first, from the
 * bottom of this list upward: what a step is *about* outlives what merely
 * describes the fleet.
 */
export const SETUP_DETAIL_ORDER = [
  "detected",
  "consultsAndReviewers",
  "overlayDiff",
  "fleetAndGates",
] as const;

type SetupDetail = (typeof SETUP_DETAIL_ORDER)[number];
type SetupDetailPlan = {
  readonly detected: readonly DetectedRow[];
  readonly retained: ReadonlySet<SetupDetail>;
  readonly retainedRows: number;
  readonly complete: boolean;
};

/** Columns the HARNESSES panel gives its body, after side rails and chrome. */
function contentInnerWidth(columns: number, layout: FrameCockpitLayout): number {
  const rails = Math.floor(columns) >= APPROVED_SIDE_RAIL_COLUMN_FLOOR
    ? 2 * sidePanelWidth(layout) + 2 // both rails and the gaps beside them
    : 0;
  return Math.max(1, Math.floor(columns) - rails - 4);
}

function gridRows(
  panels: readonly BandColumnContent[],
  inner: number,
): number {
  return measureBandRows(inner, panels);
}

function detailRows(
  detail: Exclude<SetupDetail, "detected">,
  data: SetupCockpitData,
  inner: number,
): number {
  switch (detail) {
    case "consultsAndReviewers":
      return gridRows([
        lineBandContent("CONSULTS", consultsLines(data)),
        lineBandContent("REVIEWERS", reviewersLines(data)),
      ], inner);
    case "overlayDiff":
      return panelRows(overlayDiffLines(data), inner - 4);
    case "fleetAndGates":
      return gridRows([
        lineBandContent("FLEET", fleetLines(data)),
        lineBandContent("GATES", gatesLines(data)),
      ], inner);
  }
}

/** Every detected row spends its first two columns on the state glyph and gap. */
function detectedPanelRows(rows: readonly DetectedRow[], inner: number): number {
  const columns = Math.max(1, inner - 6);
  return PANEL_CHROME_ROWS + rows.reduce(
    (total, row) =>
      total + composeBandLine(row.text.trimStart(), columns).length,
    0,
  );
}

/**
 * DETECTED is the body of the step the surface is showing, so — like the
 * journal body it stands in for (§5.4 rank 5) — it shrinks rather than being
 * replaced: it gives up rows from the bottom, never below one row per state it
 * still has to report, and only disappears when even that will not fit.
 */
function detectedPlan(
  data: SetupCockpitData,
  inner: number,
  budget: number,
): readonly DetectedRow[] {
  const all = detectedRows(data);
  if (detectedPanelRows(all, inner) <= budget) return all;
  const states = new Set<ComponentState>();
  const smallest = all.filter((row) => {
    if (states.has(row.state)) return false;
    states.add(row.state);
    return true;
  });
  if (detectedPanelRows(smallest, inner) > budget) return [];
  // Grow back toward the full panel, keeping the panel's own row order.
  const kept = new Set(smallest);
  for (const row of all) {
    if (kept.has(row)) continue;
    const grown = all.filter((candidate) =>
      kept.has(candidate) || candidate === row
    );
    if (detectedPanelRows(grown, inner) > budget) break;
    kept.add(row);
  }
  return all.filter((row) => kept.has(row));
}

function setupDetailPlan(
  rows: number,
  data: SetupCockpitData,
  inner: number,
  base: number,
  journalPreferred: number,
): SetupDetailPlan {
  // DETECTED may borrow from the review body down to its one-row minimum; the
  // configuration panels below it may not.
  const detected = detectedPlan(
    data,
    inner,
    Math.max(0, Math.floor(rows) - base - 1),
  );
  const retained = new Set<SetupDetail>(detected.length > 0 ? ["detected"] : []);
  let retainedRows = detected.length > 0
    ? detectedPanelRows(detected, inner)
    : 0;
  let available = Math.max(
    0,
    Math.floor(rows) - base - journalPreferred - retainedRows,
  );

  for (const detail of SETUP_DETAIL_ORDER.slice(1)) {
    const cost = detailRows(detail as Exclude<SetupDetail, "detected">, data, inner);
    if (available < cost) break;
    retained.add(detail);
    retainedRows += cost;
    available -= cost;
  }
  return {
    detected,
    retained,
    retainedRows,
    complete: retained.size === SETUP_DETAIL_ORDER.length
      && detected.length === detectedRows(data).length,
  };
}

function versionColumnWidth(data: SetupCockpitData): number {
  return Math.max(
    ...identityVersionLines(data).map((line) => [...line].length),
  );
}

/**
 * The banner sits beside the version column, so a narrow frame leaves it fewer
 * columns and it wraps. Charged from the banner the header actually draws.
 */
function headerRowsFor(
  layout: FrameCockpitLayout,
  data: SetupCockpitData,
  columns: number,
): number {
  if (!layout.elements.secondaryHeader) return 1;
  const banner = Math.max(1, Math.floor(columns) - versionColumnWidth(data));
  return identityBannerLines().reduce(
    (rows, line) => rows + wrappedRows(line, banner),
    0,
  );
}

function statRowsFor(
  layout: FrameCockpitLayout,
  data: SetupCockpitData,
  inner: number,
): number {
  // A tile is its value, its sparkline and its chrome; the stacked band spends
  // one more row because the widest label wraps.
  if (layout.stats.mode === "tiles") {
    return PANEL_CHROME_ROWS + 2 + (layout.arrangement === "stacked" ? 1 : 0);
  }
  return wrappedRows(statsSummaryLine(data), inner);
}

/** Every row the frame spends before the detail panels and the review body. */
function baseRows(
  layout: FrameCockpitLayout,
  data: SetupCockpitData,
  columns: number,
  inner: number,
): number {
  return headerRowsFor(layout, data, columns)
    + 2 // permanent status strip and keybar
    + 3 // outer HARNESSES panel border and title
    + statRowsFor(layout, data, inner)
    + PANEL_CHROME_ROWS; // review border and title
}

function LadderSetupPanel({
  data,
  layout,
  columns,
  rows,
  interaction,
  bindings,
  focused = true,
}: {
  data: SetupCockpitData;
  layout: FrameCockpitLayout;
  columns: number;
  rows: number;
  interaction?: SetupInteractionState;
  bindings: readonly SetupKeyBinding[];
  focused?: boolean;
}): ReactElement {
  const inner = contentInnerWidth(columns, layout);
  const preferredReviewRows = Math.min(FULL_JOURNAL_ROWS, layout.journalRows);
  const base = baseRows(layout, data, columns, inner);
  const details = setupDetailPlan(rows, data, inner, base, preferredReviewRows);
  const spare = Math.max(1, Math.floor(rows) - base - details.retainedRows);
  // Once the whole arrangement is drawn the review body is the only sink left,
  // so it absorbs the surplus; below that it holds its contracted height.
  const visibleReviewRows = details.complete
    ? spare
    : Math.min(preferredReviewRows, spare);
  const interactionPanel = SetupInteractionPanel({ data, interaction, bindings });

  return (
    <Panel title="HARNESSES" focused={focused} flexGrow={1}>
      {interactionPanel ?? (
        <>
      <SetupStats data={data} mode={layout.stats.mode} />
      {details.retained.has("detected") && (
        <HarnessRows rows={details.detected} columns={Math.max(1, inner - 6)} />
      )}
      {details.retained.has("fleetAndGates") && (
        <LineBand
          columns={inner}
          panels={[
            lineBandContent("FLEET", fleetLines(data)),
            lineBandContent("GATES", gatesLines(data)),
          ]}
        />
      )}
      {details.retained.has("consultsAndReviewers") && (
        <LineBand
          columns={inner}
          panels={[
            lineBandContent("CONSULTS", consultsLines(data)),
            lineBandContent("REVIEWERS", reviewersLines(data)),
          ]}
        />
      )}
      {details.retained.has("overlayDiff") && (
        <LinePanel
          title="OVERLAY DIFF"
          lines={overlayDiffLines(data)}
          columns={Math.max(1, inner - 4)}
          emphasis="dim"
        />
      )}
      <SizedReviewPanel
        rows={data.reviewRows}
        bodyRows={visibleReviewRows}
      />
        </>
      )}
    </Panel>
  );
}

function SetupPanel({
  data,
  inner,
  interaction,
  bindings,
  focused = true,
}: {
  data: SetupCockpitData;
  inner: number;
  interaction?: SetupInteractionState;
  bindings: readonly SetupKeyBinding[];
  focused?: boolean;
}): ReactElement {
  const interactionPanel = SetupInteractionPanel({ data, interaction, bindings });
  return (
    <Panel title="HARNESSES" focused={focused} flexGrow={1}>
      {interactionPanel ?? (
        <>
      <CockpitGrid>
        <StatTile
          label="FOUND"
          value={data.counts.found}
          samples={[data.counts.found]}
        />
        <StatTile
          label="AUTHENTICATED"
          value={data.counts.authenticated}
          samples={[data.counts.authenticated]}
        />
        <StatTile
          label="ROUTABLE"
          value={data.counts.routable}
          samples={[data.counts.routable]}
        />
      </CockpitGrid>
      <HarnessRows
        rows={detectedRows(data)}
        columns={Math.max(1, inner - 6)}
      />
      <LineBand
        columns={inner}
        panels={[
          lineBandContent("FLEET", fleetLines(data)),
          lineBandContent("GATES", gatesLines(data)),
        ]}
      />
      <LineBand
        columns={inner}
        panels={[
          lineBandContent("CONSULTS", consultsLines(data)),
          lineBandContent("REVIEWERS", reviewersLines(data)),
        ]}
      />
      <LinePanel
        title="OVERLAY DIFF"
        lines={overlayDiffLines(data)}
        columns={Math.max(1, inner - 4)}
        emphasis="dim"
      />
      <SizedReviewPanel
        rows={data.reviewRows}
        bodyRows={data.reviewRows.length}
      />
        </>
      )}
    </Panel>
  );
}

export function SetupCockpitFrame({
  data,
  columns,
  rows,
  interaction,
  bindings = SURFACE_KEY_BINDINGS.setup,
}: {
  data: SetupCockpitData;
  columns: number;
  rows?: number;
  interaction?: SetupInteractionState;
  bindings?: readonly SetupKeyBinding[];
}): ReactElement {
  const currentInteraction = interaction ?? initialSetupInteractionState();
  const focusedPanel = SETUP_PANEL_FOCUS_ORDER[currentInteraction.panel]
    ?? "HARNESSES";
  if (rows === undefined) {
    const inner = Math.max(1, Math.floor(columns) - (2 * 16) - 2 - 4);
    return (
      <Box flexDirection="column" width={columns}>
        <IdentityHeader data={data} interaction={currentInteraction} />
        <Box flexDirection="row" gap={1}>
          <NavigationPanel
            step={currentInteraction.step}
            focused={focusedPanel === "SETUP"}
          />
          <SetupPanel
            data={data}
            inner={inner}
            interaction={currentInteraction}
            bindings={bindings}
            focused={focusedPanel === "HARNESSES"}
          />
          <KeysPanel bindings={bindings} focused={focusedPanel === "KEYS"} />
        </Box>
        <StatusStrip
          width={columns}
          items={setupStatusItems(data, currentInteraction)}
        />
        <SetupKeybar bindings={bindings} width={columns} />
      </Box>
    );
  }
  const layout = resolveCockpitLayout(columns, rows);
  if (layout.renderer === "plain") return <></>;
  const showSideRails = columns >= APPROVED_SIDE_RAIL_COLUMN_FLOOR;
  const contentLayout: FrameCockpitLayout = showSideRails
    ? layout
    : {
      ...layout,
      stats: { ...layout.stats, mode: "summary", rows: 1 },
    };
  const showFullSidePanels = fullKeysFit(
    rows,
    contentLayout,
    data,
    columns,
    bindings,
  );
  const resolvedSidePanelWidth = sidePanelWidth(contentLayout);

  return (
    <Box flexDirection="column" width={columns}>
      <IdentityHeader
        data={data}
        secondary={layout.elements.secondaryHeader}
        interaction={currentInteraction}
      />
      <Box flexDirection="row" gap={showSideRails ? 1 : 0}>
        {showSideRails && (
          <Box width={resolvedSidePanelWidth} flexShrink={0}>
            <NavigationPanel
              width={resolvedSidePanelWidth}
              compact={!contentLayout.elements.secondaryHeader}
              step={currentInteraction.step}
              focused={focusedPanel === "SETUP"}
            />
          </Box>
        )}
        <LadderSetupPanel
          data={data}
          layout={contentLayout}
          columns={columns}
          rows={rows}
          interaction={currentInteraction}
          bindings={bindings}
          focused={focusedPanel === "HARNESSES"}
        />
        {showSideRails && (showFullSidePanels
          ? (
            <Box width={resolvedSidePanelWidth} flexShrink={0}>
              <KeysPanel
                bindings={bindings}
                width={resolvedSidePanelWidth}
                focused={focusedPanel === "KEYS"}
              />
            </Box>
          )
          : (
            <Box width={resolvedSidePanelWidth} flexShrink={0}>
              <CompactKeysPanel
                bindings={bindings}
                width={resolvedSidePanelWidth}
                focused={focusedPanel === "KEYS"}
              />
            </Box>
          ))}
      </Box>
      <StatusStrip
        width={columns}
        items={setupStatusItems(data, currentInteraction)}
      />
      <SetupKeybar bindings={bindings} width={columns} />
    </Box>
  );
}
