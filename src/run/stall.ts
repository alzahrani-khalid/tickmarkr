// OBS-82: normalize known presentation tokens before measuring transcript extent or filtering an
// LLM-bound transcript. This remains a closed allowlist — ANSI/VT escapes, braille-range spinner
// glyphs, and elapsed-time tokens bound to time-unit suffixes. Every other byte passes through
// identical. v1.76 deliberately stopped treating arbitrary normalized byte changes as progress:
// StallProgressTracker below requires monotonic evidence, so an unknown repaint fails closed toward
// a recoverable consult instead of holding the watchdog silent.

// CSI (with intermediates), OSC (BEL- or ST-terminated), DCS/SOS/PM/APC strings, single-char
// escapes, and charset selection — the raw-pty forms; herdr pane reads are already rendered.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x9b[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[()][0-9A-Za-z]|\x1b[0-~]/g;

// Braille patterns U+2800–U+28FF — the codex spinner cell (captured fixture: ⠋⠙⠸⠴⠦⠇ …).
const SPINNER_RE = /[⠀-⣿]/g;

// A digit run (optionally decimal) bound directly to a time-unit suffix, standing alone as a
// word: 9s, 41s, 3m, 1h, 800ms. Never bare digits — "(6/7)" and "5 of 7" stay change-sensitive.
const ELAPSED_RE = /(?<![\w.])\d+(?:\.\d+)?(?:ms|[hms])(?!\w)/g;

/** Normalize presentation tokens for transcript extent and LLM-noise classification. Trailer
 * parsing, harvest, waitOutput, and paging always read the raw text. */
export function normalizeStallSnapshot(text: string): string {
  return text.replace(ANSI_RE, "").replace(SPINNER_RE, "").replace(ELAPSED_RE, "");
}

export interface StallProgressSample {
  paneText: string;
  seedSubmitted?: boolean;
  contextTokens?: number;
}

// T1 (OBS-262): the rescue nudge's adapter scope — claude-code only (steering path proven,
// OBS-122). Widening it is a future fixture-capture chore (an occupied-frame capture per adapter,
// OBS-181 scar), never a drive-by edit. Lives in the stall module so the watchdog's policy and its
// scope constant cannot drift apart.
export const NUDGEABLE_ADAPTERS = new Set(["claude-code"]);

// T1 (OBS-263): a LIVE provider banner is the last thing the pane printed — the worker stopped
// underneath it. A "quota"/"rate limit" mention inside the task prompt, a diff hunk, or earlier
// output sits ABOVE the transcript tail and must never fail an attempt over, so the in-loop quota
// classifier reads only this many trailing non-empty rows instead of the whole retained snapshot.
// ponytail: rows, not a banner grammar — the ceiling is a worker frozen with a quota mention as its
// literal last output; the two-consecutive-slices + tracker-silence gates bound that cost to one
// failover within the routing floor. Upgrade path is a per-adapter banner fixture if it ever bites.
export const QUOTA_BANNER_TAIL_ROWS = 12;
export function stallSnapshotTail(text: string, rows: number = QUOTA_BANNER_TAIL_ROWS): string {
  return normalizeStallSnapshot(text)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-rows)
    .join("\n");
}

// T1 review (chrome-blind-matcher class, OBS-152/155): the tail of a RENDERED TUI frame is not
// "what the pane printed last" — its bottom rows are fixed composer/welcome chrome. Codex pins
// "• You have 3 usage limit resets available." there, so a raw-tail QUOTA_RE match fires on every
// frame of a wedged pane (verified against all 8 frames of tests/fixtures/codex-mcp-spinner) and
// would fail a live worker over mid-work. Filter the KNOWN chrome instead of everything on screen
// at some anchor: a novelty baseline cannot distinguish "chrome that was already there" from "a
// real banner the CLI printed before the first poll read" — a channel throttled at launch paints
// its banner inside the first BLOCKED_POLL_MS slice, so the banner BECOMES the baseline and is
// exculpated forever (proven by execution: banner-from-the-first-loop-read fails over on shipped
// 843328b0, parks human under the baseline). This line is semantically the opposite of exhaustion
// — resets AVAILABLE — so matching it out can never hide a real banner. Closed allowlist, same
// philosophy as the normalizer's: a new adapter's quota-flavored chrome is a fixture-capture
// chore, never a drive-by edit.
const QUOTA_CHROME_RE = /usage limit resets? available/i;
export function stallSnapshotBannerRows(text: string, rows: number = QUOTA_BANNER_TAIL_ROWS): string {
  return stallSnapshotTail(text, rows)
    .split("\n")
    .filter((line) => !QUOTA_CHROME_RE.test(line))
    .join("\n");
}

// T1 (OBS-262/263, speed-spec §2): past fifteen minutes with a FLAT token-usage counter, row
// growth alone no longer re-arms the inactivity window — cosmetic repaint rows are not paid work.
// Token usage is the paid-work signal the tracker already samples; token growth always re-arms.
export const ROW_REARM_TOKEN_FLAT_MS = 15 * 60_000;
// Test seam, same pattern as the daemon's timing seams: production reads the constant.
let rowRearmTokenFlatMs = ROW_REARM_TOKEN_FLAT_MS;
export function setRowRearmTokenFlatMsForTests(ms: number): void {
  rowRearmTokenFlatMs = ms;
}
export function resetRowRearmTokenFlatMsForTests(): void {
  rowRearmTokenFlatMs = ROW_REARM_TOKEN_FLAT_MS;
}

// T1 review (read-ceiling blindness): the daemon samples panes through `driver.read(slot, N)` —
// a bounded window. This constant IS that N, and the daemon's pane reads must use it (never a
// literal) so the tracker's saturation check below cannot drift away from the real read depth.
export const PANE_READ_ROWS = 1000;

/**
 * Monotonic worker-progress measure for the stall watchdog.
 *
 * Terminal chrome is allowed to repaint arbitrary bytes in place, so byte differences are not
 * evidence of work. A rendered transcript is only known to have grown when it occupies more
 * non-empty rows than any prior sample. Same-row rewrites are deliberately ambiguous and do not
 * advance the clock: a recoverable early consult is safer than silencing the watchdog forever.
 *
 * CEILING: `transcriptRows` is a monotone high-water over the daemon's bounded pane read
 * (PANE_READ_ROWS lines), so it is a one-way ratchet whose signal goes blind once the pane's
 * content exceeds the read window — the same full window slides and `observe()` can never
 * report row growth again. Past that point a `false` return means "unmeasurable", not "no
 * output" — consumers making a kill decision (the dead-channel fast-kill) must check
 * `rowSignalSaturated` and stand down on it.
 */
export class StallProgressTracker {
  private transcriptRows = 0; // non-empty high-water over the bounded read — the growth signal
  private rawWindowLines = 0; // raw-line high-water — the SATURATION signal (see the getter)
  private seedSubmitted = false;
  private contextTokens: number | undefined;
  private lastTokenGrowthAt: number | undefined; // undefined until the first token sample anchors the flat-clock
  private rowGrowthAt: number | undefined; // raw row-growth clock — NEVER suppressed by the flat-token rule

  /** True once a sample FILLED the bounded read window on RAW lines (blanks and chrome-only
   * rows included): the pane's real extent is then unknown — genuinely new content scrolls out
   * of the read and the row high-water can never advance again — so a flat tracker is blindness,
   * not silence. The raw window is the saturation signal, NOT the normalized non-empty count: a
   * production `read(slot, PANE_READ_ROWS)` returns at most PANE_READ_ROWS lines including blank
   * and chrome-only rows (measured 730 non-empty of 1000 on the codex-mcp-spinner fixture), so
   * comparing the non-empty high-water against PANE_READ_ROWS could never engage and the
   * fast-kill's stand-down was unreachable. Sticky by construction (the high-water never
   * decreases). */
  get rowSignalSaturated(): boolean {
    return this.rawWindowLines >= PANE_READ_ROWS;
  }

  /** Raw row-growth clock: the last observe() that advanced the row high-water, recorded even
   * when the flat-token rule suppresses the progress REPORT (observe returns false). T1 review:
   * the dead-channel fast-kill's "no output growth" leg must read this, not the suppressed
   * progress clock — a metered adapter whose sticky token counter freezes the report while the
   * pane keeps streaming rows is alive, and only this clock sees it. */
  get lastRowGrowthAt(): number | undefined {
    return this.rowGrowthAt;
  }

  observe(sample: StallProgressSample, now: number = Date.now()): boolean {
    let rowsAdvanced = false;
    // raw window high-water first — this is the saturation signal (rowSignalSaturated), and it
    // must see the sample exactly as the bounded read returned it, blanks and chrome included.
    const rawLines = sample.paneText.split("\n").length;
    if (rawLines > this.rawWindowLines) this.rawWindowLines = rawLines;
    const rows = normalizeStallSnapshot(sample.paneText)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .length;
    if (rows > this.transcriptRows) {
      this.transcriptRows = rows;
      rowsAdvanced = true;
      this.rowGrowthAt = now; // raw signal — advances even when the report below is suppressed
    }
    let seedAdvanced = false;
    if (sample.seedSubmitted && !this.seedSubmitted) {
      this.seedSubmitted = true;
      seedAdvanced = true;
    }
    let tokensAdvanced = false;
    const tokens = sample.contextTokens;
    if (tokens !== undefined && Number.isFinite(tokens)) {
      if (tokens > (this.contextTokens ?? 0)) tokensAdvanced = true;
      // T1 review: ANY movement re-anchors the flat-clock, not just a new high-water mark — a
      // context compaction drops the counter, and the climb back below the old peak is still paid
      // work. A high-water comparison would freeze the anchor forever on the first decrease. (The
      // first token sample always counts as movement: contextTokens starts undefined.)
      if (tokens !== this.contextTokens) this.lastTokenGrowthAt = now;
      this.contextTokens = tokens;
    }
    if (tokensAdvanced || seedAdvanced) return true;
    if (rowsAdvanced) {
      // T1: row growth past the flat-token cap is cosmetic — the paid-work counter has not moved,
      // so the inactivity window must NOT re-arm on it. A tracker that never sees a token sample
      // (unmetered adapter) keeps the old row-growth behavior.
      if (this.lastTokenGrowthAt !== undefined && now - this.lastTokenGrowthAt >= rowRearmTokenFlatMs) return false;
      return true;
    }
    return false;
  }
}

// ─── v1.65 T2: LLM-bound transcript filter ──────────────────────────────────────────────────────
// Consult dossiers and gate prompts pay tokens per transcript byte, so LLM-bound text runs through
// a per-line classifier: carriage-return overwrite churn keeps only the final paint, lines that are
// pure presentation (spinner/ANSI/elapsed only — classified via normalizeStallSnapshot above, never
// a parallel normalizer) drop, consecutive repaint frames that normalize equal squash to the last,
// and runs of passing-test lines collapse to a count line. Failure lines, exit codes, and summary
// lines always survive verbatim. Fail-open by contract: any internal error — or trivial savings —
// returns the original text; the filter may only ever cost noise, never evidence.

// Signal that must never drop: failure markers, exit codes, run summaries. Substring matches on
// purpose (AssertionError, FAILED) — over-keeping is the safe miss, same asymmetry as the allowlist.
const KEEP_RE = /[✗✖]|fail|error|exception|fatal|panic|exit\s*code|exit(?:ed)?\s+with|non-?zero|traceback|^\s*(?:tests?\b|test\s+(?:files|suites)|suites?\b|snapshots?\b|duration\b|summary\b)/i;

// Passing-test line shapes (vitest/jest/tap/go/pytest). Only KEEP-negative lines reach this class.
const PASS_RE = /^\s*(?:[✓✔√]\s|ok\s+\d|PASS\b|---\s*PASS:)|\bPASSED\b/;

const COLLAPSE_MIN = 3; // a 1–2 line run costs less than the count line that would replace it
const MIN_SAVINGS_RATIO = 0.1; // below 10% shrink the rewrite is not worth its risk — pass through

function classifyTranscript(text: string): string {
  const out: string[] = [];
  let run: string[] = [];
  let prevNorm: string | null = null;
  const flush = () => {
    if (run.length >= COLLAPSE_MIN) out.push(`[${run.length} passing-test lines collapsed]`);
    else out.push(...run);
    run = [];
  };
  for (const raw of text.split("\n")) {
    // CR overwrite churn: the final paint wins; earlier paints carrying must-keep signal survive too.
    const segs = raw.split("\r");
    for (const line of segs.filter((s, i) => i === segs.length - 1 || KEEP_RE.test(s))) {
      if (KEEP_RE.test(line)) { flush(); out.push(line); prevNorm = null; continue; }
      if (PASS_RE.test(line)) { run.push(line); prevNorm = null; continue; }
      flush();
      const norm = normalizeStallSnapshot(line);
      if (line.trim() !== "" && norm.trim() === "") continue; // pure spinner/ANSI/elapsed frame
      if (norm !== "" && norm === prevNorm) { out[out.length - 1] = line; continue; } // repaint of the prior line — latest wins
      out.push(line);
      prevNorm = norm;
    }
  }
  flush();
  return out.join("\n");
}

/** Filter transcript text bound for an LLM prompt (consult dossiers, gate prompts). The classify
 * seam exists for fault injection in tests only — production callers pass text alone. */
export function filterLlmTranscript(text: string, classify: (t: string) => string = classifyTranscript): string {
  try {
    const filtered = classify(text);
    return text.length - filtered.length < text.length * MIN_SAVINGS_RATIO ? text : filtered;
  } catch {
    return text; // fail open — a filter defect must never cost the consult its evidence
  }
}
