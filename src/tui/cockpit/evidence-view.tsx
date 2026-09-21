import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Box, useInput } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ChannelCost } from "../../report/cost.js";
import { buildOperatorRecord, formatOperatorRecordRow, type OperatorRecordRow } from "../../report/operator-record.js";
import { EMPTY_OPERATOR_PAGE_SUMMARY, foldOperatorPages, operatorPageRow, type OperatorPageGroup } from "../../run/operator-page-summary.js";
import type { EvidenceIdentity } from "../../run/operator-state.js";
import { formatJournalNarration, type JournalEvent } from "../../run/journal.js";
import { BodyText, JournalRowPanel, Panel, type ComponentState, type JournalRow } from "./components.js";
import { cellWidth, sliceCells } from "./width.js";

/** A journal row the shell/store tracks — physical line identity travels with the row. */
export interface TrackedJournalRow {
  readonly line: number;
  readonly source?: string;
  readonly id?: string;
  readonly event?: JournalEvent;
  readonly raw?: string;
  readonly error?: string;
}

/** One row the Journal/Channels/Report tabs are all read from — the true journal `#L`, never a
 *  filtered on-screen ordinal, travels with the row for its whole life. */
export interface EvidenceRow {
  readonly evidence: EvidenceIdentity;
  readonly time: string;
  readonly state: ComponentState;
  /** One-line narration for the Journal list. */
  readonly text: string;
  /** The complete recorded detail (a review verdict can run to hundreds of lines) — never truncated. */
  readonly fullText: string;
  /** Durable artifact locations this row's detail names (e.g. a saved raw-review capture); empty
   *  when none were recorded — rendered as "missing", never silently omitted. */
  readonly artifacts: readonly string[];
  readonly taskId?: string;
  readonly gate?: string;
}

// review.ts:485 emits `; raw saved: <path>) — failing closed`, the path immediately followed by
// the message's closing paren — so the capture must stop before a trailing `)`, never swallow it.
const ARTIFACT_PATTERN = /raw saved:\s*([^\s)]+)/gi;

/** Durable artifact locations named inside a gate/review's recorded detail text. */
export function parseArtifactLocations(details: string): string[] {
  return [...details.matchAll(ARTIFACT_PATTERN)].map((m) => m[1]!);
}

function stateFor(e: JournalEvent): ComponentState {
  if (e.event === "gate-result" || e.event === "review-leg2") return e.data.pass === true ? "pass" : e.data.pass === false ? "fail" : "neutral";
  if (e.event === "task-failed") return "fail";
  if (e.event === "task-human" || e.event === "task-blocked") return "warn";
  if (e.event === "merge" || e.event === "task-done" || e.event === "run-end") return "pass";
  if (e.event === "task-dispatch" || e.event === "run-start" || e.event === "run-resume") return "active";
  return "neutral";
}

/** Pure C2-journal-to-Evidence-rows mapping: the original journal position IS the evidence identity
 *  — assigned once here, from the full unfiltered event list, never recomputed from a display slice. */
export function deriveEvidenceJournal(
  eventsOrRows: readonly (JournalEvent | TrackedJournalRow)[],
  source = "journal.jsonl",
): EvidenceRow[] {
  const result: EvidenceRow[] = [];
  for (let i = 0; i < eventsOrRows.length; i++) {
    const item = eventsOrRows[i]!;
    let e: JournalEvent | undefined;
    let line: number;
    let rowSource = source;
    let id: string;
    if ("line" in item && typeof item.line === "number") {
      if (!item.event) continue;
      e = item.event;
      line = item.line;
      rowSource = item.source ?? source;
      id = item.id ?? `${rowSource}#L${line}`;
    } else {
      e = item as JournalEvent;
      line = i + 1;
      id = `${source}#L${line}`;
    }
    if (!e) continue;
    const details = typeof e.data?.details === "string" ? e.data.details : "";
    const artifacts: string[] = parseArtifactLocations(details);
    if (typeof e.data?.artifactPath === "string" && e.data.artifactPath.trim()) {
      const p = e.data.artifactPath.trim();
      if (!artifacts.includes(p)) artifacts.push(p);
    }
    const gate = typeof e.data?.gate === "string" ? e.data.gate : (e.event === "review-leg2" ? "review" : undefined);
    result.push({
      evidence: { source: rowSource, line, id },
      time: e.ts,
      state: stateFor(e),
      text: formatJournalNarration(e),
      fullText: details || JSON.stringify(e.data, null, 2),
      artifacts,
      ...(e.taskId ? { taskId: e.taskId } : {}),
      ...(gate ? { gate } : {}),
    });
  }
  return result;
}

/** The most recent review verdict recorded for a task — by original journal position, so a merged
 *  task's review opens the row it actually happened on rather than any on-screen index. */
export function selectTaskReview(journal: readonly EvidenceRow[], taskId: string): EvidenceRow | undefined {
  for (let i = journal.length - 1; i >= 0; i--) {
    const row = journal[i]!;
    if (row.taskId === taskId && (row.gate === "review" || row.gate === "review-leg2")) return row;
  }
  return undefined;
}

export interface EvidenceViewInput {
  readonly events?: readonly JournalEvent[];
  readonly rows?: readonly TrackedJournalRow[];
  readonly source?: string;
  readonly costs?: readonly ChannelCost[];
  /** Caller-supplied Report-tab text (e.g. from `renderMarkdownRecord`/`textReport`) — kept as a pure
   *  input so this leaf never reads config/telemetry itself. */
  readonly reportLines?: readonly string[];
  readonly statsLines?: readonly string[];
  readonly learningPreview?: readonly string[];
}

export interface EvidenceViewModel {
  readonly operatorPages: readonly OperatorPageGroup[];
  readonly journal: readonly EvidenceRow[];
  readonly channels: readonly OperatorRecordRow[];
  readonly reportLines: readonly string[];
  readonly statsLines: readonly string[];
  readonly learningPreview: readonly string[];
}

export function deriveEvidenceView(input: EvidenceViewInput): EvidenceViewModel {
  const source = input.source ?? "journal.jsonl";
  const items: readonly (JournalEvent | TrackedJournalRow)[] = input.rows ?? input.events ?? [];
  const events = input.rows
    ? input.rows.flatMap((r) => (r.event ? [r.event] : []))
    : (input.events ?? []);
  return {
    operatorPages: foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, items.flatMap((item, index) => {
      const tracked = "line" in item;
      const event = tracked ? item.event : item;
      if (!event) return [];
      // The source identifies the owning run; preserve physical lines across malformed rows.
      const row = operatorPageRow(event, tracked ? item.line : index + 1, tracked ? item.source ?? source : source);
      return row ? [row] : [];
    })).groups,
    journal: deriveEvidenceJournal(items, source),
    channels: buildOperatorRecord(events, input.costs ?? []),
    reportLines: input.reportLines ?? [],
    statsLines: input.statsLines ?? [],
    learningPreview: input.learningPreview?.length ? input.learningPreview : ["no telemetry yet"],
  };
}

// ── Export (AC2): pure path/plan/write — the interactive confirm dialog is C1's job at mount time.

export interface EvidenceExportTarget {
  readonly runId: string;
  /** Every spec path recorded for the run; beside-spec naming only fires when exactly one exists. */
  readonly specPaths: readonly string[];
  readonly specDir?: string;
}

/** The default beside-spec destination, or undefined when the source spec is ambiguous or unknown —
 *  an ambiguous/missing source never guesses a path; the caller must ask for explicit choice. */
export function defaultExportPath(target: EvidenceExportTarget): string | undefined {
  if (target.specPaths.length !== 1 || !target.specDir) return undefined;
  const specPath = target.specPaths[0]!;
  const base = specPath.split("/").pop() ?? specPath;
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return `${target.specDir}/${stem}.${target.runId}.report.md`;
}

export interface EvidenceExportPlan {
  readonly path: string;
  /** true ⇒ the caller must obtain explicit overwrite confirmation before writing. */
  readonly exists: boolean;
}

export function planEvidenceExport(path: string, io: { existsSync: (p: string) => boolean }): EvidenceExportPlan {
  return { path, exists: io.existsSync(path) };
}

export type EvidenceExportOutcome =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

/** Writes only once a confirmed path is in hand; reports success — with the real byte count of what
 *  landed — only after the write actually completes. A write that throws changes nothing this
 *  function reports, and the caller never sees a path/byte count before this returns.
 *
 *  Confirmation is enforced HERE, not merely documented: when the destination already exists this
 *  refuses (never calling `writeFileSync`) unless `confirmedOverwrite` is explicitly true — a caller
 *  cannot silently replace a file just by skipping `planEvidenceExport`. */
export interface EvidenceExportIO {
  existsSync: (p: string) => boolean;
  writeFileSync: (p: string, data: string, options?: { flag?: string }) => void;
  renameSync?: (oldPath: string, newPath: string) => void;
  unlinkSync?: (p: string) => void;
  statSync?: (p: string) => { size: number };
}

export function writeEvidenceExport(
  path: string,
  record: string,
  io: EvidenceExportIO,
  confirmedOverwrite = false,
): EvidenceExportOutcome {
  if (io.existsSync(path) && !confirmedOverwrite) {
    return { ok: false, reason: "exists — overwrite not confirmed" };
  }
  const dir = dirname(path);
  const base = basename(path);
  const tempPath = join(dir, `.${base}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  try {
    io.writeFileSync(tempPath, record, { flag: "wx" });
    if (io.existsSync(path) && !confirmedOverwrite) {
      try { (io.unlinkSync ?? unlinkSync)(tempPath); } catch {}
      return { ok: false, reason: "exists — overwrite not confirmed" };
    }
    (io.renameSync ?? renameSync)(tempPath, path);
  } catch (error) {
    const isEexist = (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
      || (error instanceof Error && error.message.includes("EEXIST"));
    if (!isEexist) {
      try { (io.unlinkSync ?? unlinkSync)(tempPath); } catch {}
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const bytes = (io.statSync ? io.statSync(path).size : undefined) ?? (existsSync(path) ? statSync(path).size : Buffer.byteLength(record, "utf8"));
  return { ok: true, path, bytes };
}

// ── View ─────────────────────────────────────────────────────────────────────────────────────────

const TABS = ["journal", "report", "stats", "channels", "learning"] as const;
type EvidenceTab = (typeof TABS)[number];
const TAB_TITLE: Record<EvidenceTab, string> = {
  journal: "JOURNAL", report: "REPORT", stats: "STATS", channels: "CHANNELS", learning: "LEARNING PREVIEW",
};

export interface EvidenceViewProps {
  readonly model: EvidenceViewModel;
  readonly width?: number | string;
  readonly focused?: boolean;
  /** C1's navigation target (e.g. Home/Run's "open evidence" action, or `selectTaskReview`'s row for
   *  a merged task) — opens directly on this original journal `#L` with Follow off. Changing this
   *  prop's identity re-targets the selection without a remount; omitted, the view defaults to the
   *  tail with Follow on, as before. */
  readonly focusEvidence?: EvidenceIdentity;
  readonly onSelect?: (evidence: EvidenceIdentity) => void;
  readonly onExport?: () => void;
}

/** The exported Evidence body: C1 mounts this against a live EvidenceViewModel. Selection is held by
 *  original journal line in local state — never recomputed from the array's current length — so a
 *  newly appended row can never steal it while Follow is off; toggling Follow on snaps back to the
 *  tail. */
export function EvidenceView({ model, width, focused = true, focusEvidence, onSelect, onExport }: EvidenceViewProps): ReactElement {
  const [tab, setTab] = useState<EvidenceTab>("journal");
  const [follow, setFollow] = useState(focusEvidence === undefined);
  const [selectedLine, setSelectedLine] = useState<number | undefined>(
    focusEvidence?.line ?? model.journal.at(-1)?.evidence.line,
  );

  // model.journal.length (not the array itself) drives re-selection on growth; `follow` drives the
  // snap-back-to-tail transition when the operator turns it on.
  useEffect(() => {
    if (follow) setSelectedLine(model.journal.at(-1)?.evidence.line);
  }, [model.journal.length, follow]);

  // A new inbound navigation target (C1 opening a different row) re-targets selection and turns
  // Follow off, keyed on the target's identity — not the object — so an unchanged prop re-rendered
  // as a fresh literal never re-fires and clobbers the operator's own manual navigation.
  useEffect(() => {
    if (focusEvidence) {
      setFollow(false);
      setSelectedLine(focusEvidence.line);
    }
  }, [focusEvidence?.source, focusEvidence?.line]);

  const selectedIndex = model.journal.findIndex((row) => row.evidence.line === selectedLine);
  const selectedRow = selectedIndex >= 0 ? model.journal[selectedIndex] : undefined;

  // The key handler reads the selection from this ref, never from the render it closed over: ink
  // re-subscribes the handler in an effect AFTER the frame is drawn, so a key arriving in that
  // window would act on the previous row while the screen shows the new one (Enter opened the row
  // above the highlighted one; a second fast arrow lost its step). Render resyncs it; a move
  // writes it before the state update, so the next key sees the move even with no render between.
  const lineRef = useRef(selectedLine);
  lineRef.current = selectedLine;
  const moveTo = (index: number): void => {
    const line = model.journal[index]!.evidence.line;
    lineRef.current = line;
    setSelectedLine(line);
  };

  useInput(
    (input, key) => {
      if (key.leftArrow) setTab((t) => TABS[(TABS.indexOf(t) - 1 + TABS.length) % TABS.length]!);
      if (key.rightArrow) setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length]!);
      if (input === "e" && onExport) onExport();
      if (tab !== "journal" || model.journal.length === 0) return;
      if (input === "f") setFollow((f) => !f);
      const current = model.journal.findIndex((row) => row.evidence.line === lineRef.current);
      if (key.upArrow) {
        setFollow(false);
        moveTo(Math.max(0, (current < 0 ? model.journal.length - 1 : current) - 1));
      }
      if (key.downArrow) {
        setFollow(false);
        moveTo(Math.min(model.journal.length - 1, (current < 0 ? 0 : current) + 1));
      }
      if (key.return && current >= 0 && onSelect) onSelect(model.journal[current]!.evidence);
    },
    { isActive: focused },
  );

  const journalRows: JournalRow[] = model.journal.map((row) => {
    // Leave room for physical source references and complete state labels in the narrow body.
    // The raw row opened with Enter retains the full recorded timestamp.
    const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(row.time) ? row.time.slice(11, 19) : row.time;
    const text = `#L${row.evidence.line} ${row.text}`;
    // Reserve the widest state label (18 cells), two separators and the selection pointer.
    // Bound narration before Yoga lays out the row so long task IDs cannot squeeze state words.
    const budget = typeof width === "number" ? Math.max(1, width - cellWidth(time) - 22) : undefined;
    const clipped = budget === undefined || cellWidth(text) <= budget ? text : `${sliceCells(text, budget - 1).head}…`;
    return { id: row.evidence.id, time, state: row.state, text: clipped };
  });

  return (
    <Box flexDirection="column" width={width}>
      <BodyText emphasis="strong">
        EVIDENCE {TABS.map((t) => (t === tab ? `[${TAB_TITLE[t]}]` : TAB_TITLE[t])).join("  ")}
        {tab === "journal" ? `  | Follow ${follow ? "on" : "off"}` : ""}
        {selectedRow ? `  | selected ${selectedRow.evidence.id}` : ""}
      </BodyText>
      {tab === "journal" && (
        <>
          <JournalRowPanel title="RAW JOURNAL" rows={journalRows} selection={selectedIndex >= 0 ? selectedIndex : undefined} />
          <Panel title="OPERATOR PAGE GROUPS">
            {model.operatorPages.length ? model.operatorPages.map((group, index) => (
              <Box key={`${group.key}:${index}`} flexDirection="column">
                <BodyText emphasis="strong">{group.taskId} · {group.park} · {group.status}</BodyText>
                <BodyText>first {group.firstEvidenceAt}</BodyText>
                <BodyText>last {group.lastEvidenceAt}</BodyText>
                <BodyText>visible {group.observedCount} · suppressed {group.suppressedCount}{group.rawOnly ? " · raw-only (suppression unrecorded)" : ""}</BodyText>
                <BodyText>Raw source lines (↑↓ select, Enter open):</BodyText>
                {group.lines.map(line => <BodyText key={line}>#L{line}</BodyText>)}
              </Box>
            )) : <BodyText emphasis="dim">no operator pages</BodyText>}
          </Panel>
          <Panel title="SELECTED EVIDENCE">
            {selectedRow
              ? (
                <>
                  <BodyText emphasis="dim">Original journal {selectedRow.evidence.id}</BodyText>
                  {selectedRow.fullText.split("\n").map((line, i) => <BodyText key={i}>{line}</BodyText>)}
                  <BodyText emphasis="dim">
                    Artifacts: {selectedRow.artifacts.length ? selectedRow.artifacts.join(", ") : "missing"}
                  </BodyText>
                </>
              )
              : <BodyText emphasis="dim">no history</BodyText>}
          </Panel>
        </>
      )}
      {tab === "report" && (
        <Panel title="REPORT">
          {model.reportLines.length
            ? model.reportLines.map((line, i) => <BodyText key={i}>{line}</BodyText>)
            : <BodyText emphasis="dim">no history</BodyText>}
        </Panel>
      )}
      {tab === "stats" && (
        <Panel title="STATS">
          {model.statsLines.length
            ? model.statsLines.map((line, i) => <BodyText key={i}>{line}</BodyText>)
            : <BodyText emphasis="dim">no history</BodyText>}
        </Panel>
      )}
      {tab === "channels" && (
        <Panel title="CHANNELS">
          {model.channels.length
            ? model.channels.map((row) => (
              <BodyText key={row.channel}>
                {formatOperatorRecordRow(row)}
              </BodyText>
            ))
            : <BodyText emphasis="dim">no history</BodyText>}
        </Panel>
      )}
      {tab === "learning" && (
        <Panel title="LEARNING PREVIEW">
          {model.learningPreview.map((line, i) => <BodyText key={i}>{line}</BodyText>)}
        </Panel>
      )}
    </Box>
  );
}
