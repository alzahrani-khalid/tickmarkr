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

/**
 * Monotonic worker-progress measure for the stall watchdog.
 *
 * Terminal chrome is allowed to repaint arbitrary bytes in place, so byte differences are not
 * evidence of work. A rendered transcript is only known to have grown when it occupies more
 * non-empty rows than any prior sample. Same-row rewrites are deliberately ambiguous and do not
 * advance the clock: a recoverable early consult is safer than silencing the watchdog forever.
 */
export class StallProgressTracker {
  private transcriptRows = 0;
  private seedSubmitted = false;
  private contextTokens: number | undefined;

  observe(sample: StallProgressSample): boolean {
    let advanced = false;
    const rows = normalizeStallSnapshot(sample.paneText)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .length;
    if (rows > this.transcriptRows) {
      this.transcriptRows = rows;
      advanced = true;
    }
    if (sample.seedSubmitted && !this.seedSubmitted) {
      this.seedSubmitted = true;
      advanced = true;
    }
    const tokens = sample.contextTokens;
    if (tokens !== undefined && Number.isFinite(tokens)) {
      if (tokens > (this.contextTokens ?? 0)) advanced = true;
      this.contextTokens = Math.max(this.contextTokens ?? 0, tokens);
    }
    return advanced;
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
