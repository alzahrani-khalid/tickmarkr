/**
 * HYG-09 (D-07) probe rig lifecycle — scratch-workspace teardown that cannot leak.
 *
 * The measurement probe (measure-trailer-width.mjs) must build its rig inside a dedicated UNFOCUSED
 * scratch workspace and close the whole workspace in a finally — including on every die()/error path,
 * which today exit before any teardown (the exact leak that left six dead VIS09-* tabs in the
 * operator's workspace). Extracted here so it is unit-testable with a stubbed herdrSh: zero tokens,
 * no herdr binary required.
 *
 * A2 caveat (44-RESEARCH): `herdr workspace close <id>` semantics are assumed from the subcommand name
 * (existence verified via `herdr workspace --help`). The per-tab `tab close` on the happy path stays the
 * proven cleaner; the workspace close is the leak backstop that guarantees teardown even when the rig
 * body throws before reaching the per-tab closes. Belt and braces.
 *
 * OBS-07 (v1.25 T4): loop-safe padding + vendor-refusal-as-verdict live here so the measure script and
 * zero-token unit tests share one implementation. Padding is varied numbered words (no long char runs,
 * no repeated 12-char substrings). A vendor loop-refusal is an honest "not measurable" cell that never
 * schedules a retry.
 */

// herdr workspace create returns result.workspace (+ result.tab + result.root_pane), per the herdr skill
// (SKILL.md: "workspace create returns result.workspace, result.tab, and result.root_pane"). The id is
// parsed with the same defensive idiom the main script uses for tab create.
export function parseWorkspaceId(stdout) {
  try {
    const res = JSON.parse(stdout).result;
    const id = res?.workspace?.workspace_id ?? res?.workspace?.id ?? res?.workspace_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Build a rig inside a dedicated `workspace create --no-focus` scratch workspace, closing the whole
 * workspace in a finally on every path (success or thrown error). `herdrSh` is injected so tests pass a
 * recording stub (the real script passes its spawnSync-backed herdrSh).
 *
 * Returns fn's value on success; propagates fn's throw AFTER the workspace close has run. If workspace
 * create itself fails, throws loudly WITHOUT attempting a close of what was never created (fail loud,
 * don't close what doesn't exist).
 *
 * @param {(cmd: string) => {code: number, stdout: string, stderr: string}} herdrSh — runs a herdr command
 * @param {(wsId: string) => unknown | Promise<unknown>} fn — the rig body, given the scratch workspace id
 */
export async function withScratchWorkspace(herdrSh, fn) {
  const create = herdrSh("workspace create --no-focus");
  if (create.code !== 0) {
    throw new Error(`herdr workspace create --no-focus failed (exit ${create.code}): ${create.stderr || create.stdout}`);
  }
  const wsId = parseWorkspaceId(create.stdout);
  if (!wsId) {
    throw new Error(`herdr workspace create returned no workspace id: ${create.stdout}`);
  }
  try {
    return await fn(wsId);
  } finally {
    herdrSh(`workspace close ${wsId}`);
  }
}

// --- OBS-07: loop-safe padding + refusal-as-verdict ---------------------------------------------

// cursor's "Agent Looping Detected" (OBS-07) and close cousins. A match is a measurement outcome,
// not a transient failure — never retried.
export const VENDOR_REFUSAL_RE =
  /loop(?:ing)? detected|agent looping|stuck in a repeat|repeating response pattern/i;

/**
 * OBS-07: varied numbered-word padding for the probe trailer summary.
 * By construction: no identical-character run longer than 8, and no 12-char substring that repeats
 * (vendors' loop detectors trip on "xxxx…" / short repeating patterns).
 *
 * @param {number} [wordCount=40]
 * @returns {string}
 */
export function buildLoopSafePadding(wordCount = 40) {
  const n = Math.max(1, Math.floor(Number(wordCount) || 40));
  // Unique word-NNN tokens (zero-padded) joined by single spaces — length ~ prior long summary,
  // zero long char-runs, and every 12-char window is unique because each token number differs.
  return (
    "VIS-09 trailer-width probe: " +
    Array.from({ length: n }, (_, i) => `word-${String(i + 1).padStart(3, "0")}`).join(" ")
  );
}

/** True when harvest text matches a known vendor loop-refusal fingerprint. */
export function isVendorRefusal(raw) {
  return VENDOR_REFUSAL_RE.test(String(raw ?? ""));
}

/**
 * Score one probe cell. Vendor refusal → honest "not measurable", retry:false (never burn another
 * invocation). Successful / non-refusal cells keep measured-width fields (cols, parseOk, summaryLen)
 * unchanged in meaning.
 *
 * @param {{ raw: string, parseOk: boolean, cols: number, summaryLen?: number }} input
 * @returns {{ cols: number, parseOk: boolean, refused: boolean, measurable: boolean, status: string, retry: false, summaryLen: number }}
 */
export function scoreProbeCell({ raw, parseOk, cols, summaryLen = 0 }) {
  if (isVendorRefusal(raw)) {
    return {
      cols,
      parseOk: false,
      refused: true,
      measurable: false,
      status: "not measurable",
      retry: false, // OBS-07: refusal is a verdict, never a retry signal
      summaryLen: 0,
    };
  }
  return {
    cols,
    parseOk: !!parseOk,
    refused: false,
    measurable: true,
    status: parseOk ? "ok" : "unparsed",
    retry: false,
    summaryLen: summaryLen ?? 0,
  };
}
