#!/bin/bash
# watch-parks.sh — wake the AUTHORITY seat on the one event that cannot proceed without it.
#
# A `task-human` park is a decision, and a decision is this seat's column. Every other tier can keep
# working around a park; the park itself waits for a ruling and nothing else releases it.
#
# WHY THIS EXISTS, 2026-08-07: this seat shipped an auto-supersede so a stalled orchestrator would stop
# needing it. That worked — ten interventions, pipeline moving, no wakes. But its only remaining wake was
# an artifact watcher pointed at a run-end file THAT HAD ALREADY BEEN WRITTEN, and a watcher whose trigger
# has passed is not coverage, it is a process that will never fire. A park was then found only because the
# seat happened to look — NO watcher covered parks at all.
#
# **Automating an unblock removes your NOTIFICATION without removing your RESPONSIBILITY.** Every time you
# make a tier need you less, re-ask what still needs you and arm for that.
#
# ⚠ The first version of this comment claimed the park sat "THREE HOURS AND THIRTEEN MINUTES". It sat TEN.
# The author compared UTC journal timestamps against a local wall clock (+03) and shipped the error inside
# a self-criticism — the one sentence nobody audits, including its writer. The gap is real and the watcher
# is justified by the ABSENCE OF COVERAGE, not by that number. See OBS-435.
#
# Prints ONE wake reason, ending with its `CURSOR <run> <line>` receipt, and exits. Re-arm after every
# wake WITH that receipt: it is the acknowledgment, and only the rows it covers are suppressed.
#
# usage: watch-parks.sh <runs-dir> [poll-s] [cap-s] [--since-run <run-id> --since-line <n>]
#   Tracks the NEWEST run (the latestRunId rule: lexical run-id order, journal present), so it follows a
#   resume or a fresh run without being re-aimed.
#
# ── THE CURSOR (D-829) — what replaced arm-time seeding ────────────────────────────────────────────────
# Earlier versions seeded on the journal AS ARMED — a park count, then a line baseline. Both read "already
# in the file when I started" as "already ruled", and the gap between a wake and its re-arm is exactly
# where that is false: a park appended while the seat was busy ruling the last one was seeded as history
# and never reported, released or not. The seat's own acknowledgment is the only honest baseline, so the
# START read happens before any sleep. The closed cursor inputs:
#   same-run acknowledged  receipt run == newest run: complete rows at lines <= n are suppressed, no others
#   gap park               a task-human row after n is reported at START
#   later-release          a gap park released before the re-arm is STILL reported — this answers "which
#                          parks has the seat not seen", never "which parks are still open"
#   new-run                newest run != receipt run (or no receipt): the receipt resets to line 0
#   empty-run              no run has a journal yet: the receipt is `CURSOR none 0`, and re-arming with
#                          `--since-run none --since-line 0` is the same as no receipt, so the first run
#                          that appears is read from line 0
#   torn tail              a final line without its newline is not a row: never reported, never counted, so
#                          the cursor never advances past it and its completed form is reported later
# A receipt line beyond its run's complete lines is not this journal's acknowledgment: refused (exit 65),
# because silently suppressing rows on a mismatched receipt is the failure this file exists to prevent.
# A journal that cannot be read is not an empty scan: exit 66, no receipt, no WATCH_CAP_REACHED. Nor is a
# runs dir or run directory that cannot be listed or searched: discovery skips only ABSENCE (no runs dir
# yet, a run with no journal yet), because falling back to an older run hides the newest run's parks. Any
# other reader failure, or reader output whose last line is not a receipt, is an error too — never
# "nothing new".
#
# A `run-end` after the cursor wakes too (the milestone verdict is a decision), and a park wake reports a
# run-end in the same range, so a returned cursor never covers a row the seat was not shown.

set -u
POS=() SINCE_RUN="" SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since-run) SINCE_RUN="${2-}"; shift; [ $# -gt 0 ] && shift ;;
    --since-line) SINCE="${2-}"; shift; [ $# -gt 0 ] && shift ;;
    *) POS+=("$1"); shift ;;
  esac
done
RUNS="${POS[0]:?runs dir required (e.g. .tickmarkr/runs)}"
POLL="${POS[1]:-45}"
CAP="${POS[2]:-28800}"
# The receipt is both halves or neither: a line without its run cannot be bound to a journal. Run ids follow
# parseRunId (src/run/journal.ts): run- then an alphanumeric, then alphanumerics, `_` or `-`.
if [ -n "$SINCE_RUN$SINCE" ] && ! [[ ( "$SINCE_RUN" =~ ^run-[A-Za-z0-9][A-Za-z0-9_-]*$ && "$SINCE" =~ ^[0-9]+$ ) || ( "$SINCE_RUN" = none && "$SINCE" = 0 ) ]]; then
  echo "watch-parks.sh: the receipt is --since-run <run-id> --since-line <n> together, got run='$SINCE_RUN' line='$SINCE'" >&2
  exit 64
fi

# ONE JSON reader for every scan, START and poll alike. It applies the journal reader's rule
# (src/run/journal.ts parseJournalText: skip blanks, drop an unparseable line, keep each row's PHYSICAL
# line) to the newline-terminated lines only. argv: runs dir, receipt run, receipt line. Prints the wake, if
# any, then always `CURSOR <run> <last complete line>` (the receipt unchanged while no run has a journal).
# Exit 0 = scanned (a wake is any line before the receipt), 65 = refused receipt, 66 = failed read. It sets exitCode rather than calling exit, so a
# wake larger than the pipe buffer drains before node quits (a 1,500-park wake was cut off mid-list).
# It reports rows; it never refolds which parks are still open — that is the decision fold's job.
READER='
process.exitCode = (() => {
const fs = require("fs"), { join } = require("path");
const [runs, sinceRun, sinceLine] = process.argv.slice(1);
const fail = (what, e) => { console.error(`watch-parks.sh: cannot read ${what}: ${e.code ?? e.message}`); return 66; };
// Discovery: newest run id first, skipping only a journal that is ABSENT (ENOENT/ENOTDIR). EACCES on an
// unsearchable run directory, or ELOOP, is a failed read, never a fall-back to an older run.
let ids = [];
try { ids = fs.readdirSync(runs).filter((d) => d.startsWith("run-")).sort().reverse(); } catch (e) {
  if (e.code !== "ENOENT") return fail(runs, e);
}
let run, file;
for (const id of ids) {
  const f = join(runs, id, "journal.jsonl");
  try { fs.statSync(f); } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
    return fail(f, e);
  }
  [run, file] = [id, f];
  break;
}
if (!run) { console.log(`CURSOR ${sinceRun || "none"} ${sinceLine || 0}`); return 0; }
const since = run === sinceRun ? Number(sinceLine) : 0;
let text;
try { text = fs.readFileSync(file, "utf8"); } catch (e) { return fail(file, e); }
const lines = text.split("\n");
const complete = lines.length - 1; // the last element is "" or a torn tail: never a complete line
if (since > complete) {
  console.error(`watch-parks.sh: receipt ${run} line ${since} is beyond its ${complete} complete lines — not an acknowledgment of this journal`);
  return 65;
}
const parks = [], ends = [];
for (let n = since + 1; n <= complete; n++) {
  let row;
  try { row = JSON.parse(lines[n - 1]); } catch { continue; }
  if (row?.event === "task-human") parks.push([n, row]);
  else if (row?.event === "run-end") ends.push([n, row]);
}
const out = [];
if (parks.length) {
  out.push(`PARK ${parks.length} new — ${run}`);
  for (const [n, row] of parks) out.push(`  ${row.taskId}: ${String(row.data?.reason ?? "").replace(/\s+/g, " ").slice(0, 160)}`, `    park ${n}@${row.ts}`);
  out.push("  a park waits for a RULING and nothing else releases it — read the gate evidence, then rule");
}
if (ends.length) {
  out.push(`RUN_END ${run} tipVerify=${ends.at(-1)[1].data?.tipVerify ?? "unknown"}`);
  out.push("  read tipVerify as a FIELD; a failing verify is a DIFFERENT event with no pass field");
}
out.push(`CURSOR ${run} ${complete}`);
console.log(out.join("\n"));
return 0;
})();
'

# Sets `last` to the scan, which always ends in its receipt, and returns 0; any nonzero is a failed read.
CURSOR_RE='^CURSOR (run-[A-Za-z0-9][A-Za-z0-9_-]* [0-9]+|none 0)$'
scan() {
  last=$(node -e "$READER" "$RUNS" "$SINCE_RUN" "$SINCE") || return
  [[ "${last##*$'\n'}" =~ $CURSOR_RE ]] || { echo "watch-parks.sh: reader output ended without a receipt" >&2; return 70; }
}

elapsed=0 last=""
while :; do
  scan || { rc=$?; echo "WATCH_ERROR — journal scan failed (status $rc); no receipt, no coverage until re-armed" >&2; exit "$rc"; }
  # Only a wake prints lines before its receipt.
  [[ "$last" == *$'\n'* ]] && { printf '%s\n' "$last"; exit 0; }
  [ "$elapsed" -ge "$CAP" ] && break
  sleep "$POLL"
  elapsed=$((elapsed + POLL))
done

echo "WATCH_CAP_REACHED — no new park or run-end in ${CAP}s"
printf '%s\n' "$last"
