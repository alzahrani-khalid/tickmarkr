/**
 * Display-cell measurement by grapheme cluster — the cockpit's width authority.
 *
 * Terminals advance on grapheme clusters, not code points: a ZWJ emoji
 * sequence, a regional-indicator flag pair, a skin-tone-modified emoji and a
 * variation-selector sequence each occupy the cells of ONE cluster, while
 * zero-width combining marks add no cells at all. Counting code points
 * over-charges every one of them.
 *
 * Every operation a cockpit surface performs on text — measure it, find which
 * glyph sits under a cell, cut it for a wrap, wrap it into rows, clip it into
 * a fixed column — is exported here, each cluster-safe and each reporting the
 * cell count it produced, so a caller states policy (where to break, what to
 * pad with, which continuation marker to use) and never does cell arithmetic
 * to carry it out. `width.test.ts` pins that coverage against the arithmetic
 * the live call sites perform today.
 *
 * Migration of those call sites is deliberately NOT here. The spec's
 * separability law gives every file exactly one owning task, and the callers
 * that hand-count code points today are owned elsewhere: `layout.ts` by T3,
 * `run-cockpit.tsx`/`live.ts` by T4, `components.tsx` by T5 — each of which
 * carries this file in its context list precisely so it migrates onto these
 * exports. T1 writing into those files would be the concurrent overwrite of
 * another task's surface that the law exists to prevent (OBS-212), so this
 * task owes them a complete module, and owes them nothing else.
 *
 * ponytail: the base-character width table is `string-width`, which
 * `components.tsx` already imports — borrowing it leaves the cockpit ONE East
 * Asian width model instead of two that disagree wherever Unicode moved on
 * (the OBS-198 failure class). This module owns the grapheme layer and decides
 * one width per cluster; marks and joiners are never handed to the table as
 * separately chargeable characters.
 */

import stringWidth from "string-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const ZERO_WIDTH_CLUSTER_PART = /[\p{Mn}\p{Me}\p{Cf}]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const TEXT_VARIATION_SELECTOR = "\uFE0E";
const EMOJI_VARIATION_SELECTOR = "\uFE0F";
const COMBINING_ENCLOSING_KEYCAP = "\u20E3";

/**
 * ECMA-48 control strings and escape sequences used by terminal output. The
 * alternatives are ordered longest first: OSC/DCS strings must be consumed
 * through their BEL or ST terminator before the shorter two-byte ESC form can
 * match their introducer. CSI accepts either the seven-bit ESC [ form or its
 * eight-bit C1 equivalent.
 */
const ANSI_SEQUENCE =
  /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u009D[\s\S]*?(?:\u0007|\u009C)|\u001B[P^_X][\s\S]*?\u001B\\|[\u0090\u0098\u009E\u009F][\s\S]*?\u009C|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[@-_])/gu;

interface DisplayUnit {
  readonly text: string;
  readonly cells: number;
  readonly control: boolean;
}

function segmentedGraphemes(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map(({ segment }) => segment);
}

/**
 * Resolve one segmented grapheme to the cells a terminal advances for it.
 * Emoji-presentation clusters are a single double-cell glyph. Every other
 * cluster takes the width of its first printable base; non-spacing marks,
 * enclosing marks, variation selectors and joiners cannot add cells merely
 * because an older width table iterates their code points.
 */
function clusterCells(cluster: string): number {
  const emojiPresentation =
    !cluster.includes(TEXT_VARIATION_SELECTOR) &&
    (cluster.includes(EMOJI_VARIATION_SELECTOR) ||
      cluster.includes(COMBINING_ENCLOSING_KEYCAP) ||
      EMOJI_PRESENTATION.test(cluster));
  if (emojiPresentation) return 2;

  for (const character of cluster) {
    if (!ZERO_WIDTH_CLUSTER_PART.test(character)) return stringWidth(character);
  }
  return 0;
}

/**
 * Tokenize controls before grapheme segmentation. ANSI payload bytes are not
 * printable graphemes: each complete control is one atomic zero-cell unit,
 * while the plain spans between controls are segmented by UAX #29.
 */
function displayUnits(text: string): DisplayUnit[] {
  const units: DisplayUnit[] = [];
  let plainStart = 0;

  for (const match of text.matchAll(ANSI_SEQUENCE)) {
    const controlStart = match.index;
    for (const cluster of segmentedGraphemes(text.slice(plainStart, controlStart))) {
      units.push({ text: cluster, cells: clusterCells(cluster), control: false });
    }
    units.push({ text: match[0], cells: 0, control: true });
    plainStart = controlStart + match[0].length;
  }

  for (const cluster of segmentedGraphemes(text.slice(plainStart))) {
    units.push({ text: cluster, cells: clusterCells(cluster), control: false });
  }
  return units;
}

/** Split a string into its grapheme clusters (UAX #29). */
export function graphemeClusters(text: string): string[] {
  return segmentedGraphemes(text);
}

/**
 * Display cells occupied by `text`, summed cluster by cluster. Summing the
 * parts rather than measuring the whole is what keeps measurement, location
 * and slicing agreeing: every cell this returns belongs to exactly one cluster
 * the other three can name.
 */
export function cellWidth(text: string): number {
  return displayUnits(text).reduce((cells, unit) => cells + unit.cells, 0);
}

export interface CellLocation {
  readonly clusterIndex: number;
  readonly cluster: string;
  /** First cell of the cluster, inclusive. */
  readonly cellStart: number;
  /** End of the cluster, exclusive. */
  readonly cellEnd: number;
}

/**
 * Resolve a cell offset to the grapheme cluster covering it. The result is
 * always a whole cluster — resolution never lands mid-cluster, so both cells
 * of a double-cell cluster resolve to that same cluster. Returns null when the
 * offset is not a non-negative integer inside the string's cell span.
 */
export function locateCell(text: string, cellOffset: number): CellLocation | null {
  if (!Number.isInteger(cellOffset) || cellOffset < 0) return null;
  let cellStart = 0;
  let clusterIndex = 0;
  for (const unit of displayUnits(text)) {
    if (unit.control) continue;
    const cellEnd = cellStart + unit.cells;
    if (cellOffset < cellEnd) {
      return { clusterIndex, cluster: unit.text, cellStart, cellEnd };
    }
    cellStart = cellEnd;
    clusterIndex += 1;
  }
  return null;
}

export interface CellSlice {
  /** The leading whole clusters that were taken. */
  readonly head: string;
  /** Everything after them — `head + tail` reconstructs the input. */
  readonly tail: string;
  /** Cells `head` occupies, so a caller never re-measures what it just cut. */
  readonly cells: number;
}

/**
 * Cut `text` for a wrap: the longest leading run of whole clusters fitting
 * `maxCells`. A leading cluster wider than `maxCells` is taken anyway —
 * mirroring a terminal painting one glyph past the cells left to it, and
 * guaranteeing a wrap loop advances instead of stalling on a glyph too wide
 * for its column. `cells` therefore exceeds `maxCells` in that one case, and
 * only there. `maxCells` below 1 takes nothing.
 */
export function sliceCells(text: string, maxCells: number): CellSlice {
  let head = "";
  let cells = 0;
  let clusters = 0;
  if (maxCells >= 1) {
    for (const unit of displayUnits(text)) {
      if (!unit.control && clusters > 0 && cells + unit.cells > maxCells) break;
      head += unit.text;
      cells += unit.cells;
      if (!unit.control) clusters += 1;
    }
  }
  return { head, tail: text.slice(head.length), cells };
}

/**
 * Divide text into its first word and subsequent space-prefixed runs without
 * ever splitting a cluster or ANSI control. Keeping separators in the runs is
 * what makes wrapping lossless at a line break. A combining mark following a
 * space forms one non-separator cluster, so it stays attached to its word.
 */
function spacePrefixedRuns(text: string): string[] {
  const runs: string[] = [];
  let run = "";
  let hasWordCluster = false;

  for (const unit of displayUnits(text)) {
    if (!unit.control && unit.text === " " && hasWordCluster) {
      runs.push(run);
      run = " ";
      hasWordCluster = false;
      continue;
    }
    run += unit.text;
    if (!unit.control && unit.text !== " ") hasWordCluster = true;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export interface WrapCellsOptions {
  /** Prefix painted on fitting rows after the first, included in each result. */
  readonly continuationPrefix?: string;
}

/**
 * Wrap `text` into rows of at most `maxCells` cells — greedy, breaking between
 * words, and cutting a word that cannot fit a row of its own on a cluster
 * boundary. This is the operation that forces cell arithmetic on a caller that
 * lacks it (`width - measure(current)`, repeated), so it is exported rather
 * than left to be rebuilt per surface; a caller keeps only its own policy —
 * padding and how many rows it will draw. Continuation-marker policy lives in
 * this operation too: when supplied, its measured cells are deducted from
 * subsequent content budgets and the returned continuation rows include it.
 *
 * Rows are never empty of intent. Without a continuation prefix, joining them
 * re-inserts no space that was not in the input and drops none that was. A row
 * exceeds `maxCells` only when its content is a single cluster too wide for
 * the full budget. A continuation prefix is omitted when it leaves no content
 * cell or would make such an over-wide cluster overflow; a marker can therefore
 * never create an overflow or a non-advancing wrap. Always returns at least
 * one row.
 */
export function wrapCells(
  text: string,
  maxCells: number,
  options: WrapCellsOptions = {},
): string[] {
  const budget = Math.max(1, Math.floor(maxCells));
  const requestedPrefix = options.continuationPrefix ?? "";
  const prefixCells = cellWidth(requestedPrefix);
  const continuationPrefix = prefixCells < budget ? requestedPrefix : "";
  const continuationBudget = continuationPrefix.length > 0
    ? budget - prefixCells
    : budget;
  const contentRows: string[] = [];
  let row = "";
  let rowCells = 0;

  const contentBudget = (): number =>
    contentRows.length === 0 ? budget : continuationBudget;

  for (const run of spacePrefixedRuns(text)) {
    let rest = run;
    while (rest.length > 0) {
      const available = contentBudget() - rowCells;
      const restCells = cellWidth(rest);
      if (restCells <= available) {
        row += rest;
        rowCells += restCells;
        break;
      }

      // Prefer a word boundary: a whole space-prefixed run that fits on the
      // next row should not be hard-cut merely to fill the current one.
      if (row.length > 0 && restCells <= continuationBudget) {
        contentRows.push(row);
        row = "";
        rowCells = 0;
        continue;
      }

      const { head, tail, cells } = sliceCells(rest, Math.max(1, available));
      // `sliceCells` deliberately takes an over-wide first cluster to ensure
      // progress. That escape hatch is valid only on an otherwise empty row;
      // flush existing content before retrying it against a fresh budget.
      if (row.length > 0 && cells > available) {
        contentRows.push(row);
        row = "";
        rowCells = 0;
        continue;
      }
      row += head;
      rowCells += cells;
      rest = tail;
      contentRows.push(row);
      row = "";
      rowCells = 0;
    }
  }

  if (row.length > 0 || contentRows.length === 0) contentRows.push(row);
  return contentRows.map((content, index) => {
    if (
      index === 0 ||
      continuationPrefix.length === 0 ||
      prefixCells + cellWidth(content) > budget
    ) {
      return content;
    }
    return `${continuationPrefix}${content}`;
  });
}

/**
 * Clip `text` into a fixed column: the result occupies exactly `cells` display
 * cells, space-padded when the text is short and cut on a cluster boundary
 * when it is long. A cluster that will not fit whole is dropped rather than
 * half-drawn, so a clipped line can never overflow its region — the frame
 * plan's spans hold by construction, not by the caller's care.
 */
export function fitCells(text: string, cells: number): string {
  if (cells < 1) return "";
  let clipped = "";
  let used = 0;
  for (const unit of displayUnits(text)) {
    if (used + unit.cells > cells) break;
    clipped += unit.text;
    used += unit.cells;
  }
  return clipped + " ".repeat(cells - used);
}
