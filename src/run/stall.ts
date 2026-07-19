// OBS-82: codex's MCP-startup spinner repaints a braille glyph + elapsed-time cell forever, so the
// daemon's raw snapshot compare reads a wedged pane as active and the stall clock never fires.
// This normalizer deletes ONLY presentation tokens from a closed allowlist — ANSI/VT escape
// sequences, braille-range spinner glyphs, and elapsed-time tokens bound to time-unit suffixes.
// Every other byte passes through identical: words, paths, server names, and progress counts
// (a five-of-seven counter change IS activity) all remain change-sensitive. The asymmetry is the
// design: an allowlist MISS degrades to today's recoverable no-reap behavior, while an over-broad
// deletion would reap a healthy worker — a new failure class. Grow the allowlist only with
// captured evidence (tests/fixtures/codex-mcp-spinner/).

// CSI (with intermediates), OSC (BEL- or ST-terminated), DCS/SOS/PM/APC strings, single-char
// escapes, and charset selection — the raw-pty forms; herdr pane reads are already rendered.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x9b[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[()][0-9A-Za-z]|\x1b[0-~]/g;

// Braille patterns U+2800–U+28FF — the codex spinner cell (captured fixture: ⠋⠙⠸⠴⠦⠇ …).
const SPINNER_RE = /[⠀-⣿]/g;

// A digit run (optionally decimal) bound directly to a time-unit suffix, standing alone as a
// word: 9s, 41s, 3m, 1h, 800ms. Never bare digits — "(6/7)" and "5 of 7" stay change-sensitive.
const ELAPSED_RE = /(?<![\w.])\d+(?:\.\d+)?(?:ms|[hms])(?!\w)/g;

/** Normalize one pane snapshot for the stall-inactivity compare (and ONLY that compare — trailer
 * parsing, harvest, waitOutput, and paging read the raw text). Two snapshots that normalize equal
 * are the same frame modulo spinner presentation; any other byte difference is worker activity. */
export function normalizeStallSnapshot(text: string): string {
  return text.replace(ANSI_RE, "").replace(SPINNER_RE, "").replace(ELAPSED_RE, "");
}
