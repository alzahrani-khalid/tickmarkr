import { readableExcerpt } from "../run/journal.js";

// OBS-1106 residual: a red whose assertion is a timeout or a wall-clock budget, and the runner-level
// diagnostics (never-started files, a worker RPC timeout) that make such a red infrastructure-SHAPED.
// Shape alone never parks anything: it only buys one isolated re-observation before a charge. A
// fresh-fingerprint section masks digits to `#`, so both spellings of a number are read.
// v2.6.6 C: the daemon's declarations (src/run/daemon.ts at 75dc3187:492-494), exported verbatim so the
// manifest gate's one remeasurement and the daemon's isolated adjudication read ONE predicate.
export const TIMEOUT_SHAPED_RE = /\b(?:Test|Hook) timed out in (?:\d+|#)\s*ms\b|\bexpected (?:\d+|#)(?:\.(?:\d+|#))? to be (?:less than|below)(?: or equal to)? (?:\d+|#)/i;
export const RUNNER_INFRA_DIAGNOSTIC_RE = /\bnever-started (?:[1-9]\d*|#)(?![\d#])|\[vitest-worker\]: Timeout calling\b/;
export const timeoutShaped = (details: string) => TIMEOUT_SHAPED_RE.test(readableExcerpt(details));
