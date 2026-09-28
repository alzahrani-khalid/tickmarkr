#!/bin/bash
# classify-vitest-log.sh <log> — the ONE strict Vitest log classifier (OBS-1184). The public CI
# wrapper (scripts/run-ci-vitest.sh) and grade-ci.sh both call it, so the badge and the grade cannot
# disagree. Reads a raw Vitest log or a gh job log (gh's "job<TAB>step<TAB>timestamp " prefix and ANSI
# styling — the raw ESC byte and gh's `^[` rendering of it — are stripped) and prints ONE line:
#   VITEST_LOG verdict=<CLEAN|RPC_ONLY|RED> reason=<why> summaries=S passed=P skipped=K failed=F
#     timedout=T unhandled=U runner_rpc_timeouts=R coverage_misses=C signals=G terminal_errors=E
# unhandled counts the unhandled errors that are NOT runner RPC timeouts. Exit 0 CLEAN or RPC_ONLY, 1 RED.
#
# RED unless every Vitest summary is complete (Test Files, Tests and Duration lines, and every
# "Unhandled Errors" block closed by the summary that follows it — a cut-off log is RED), with no
# failed file or test, no timed-out test or hook, no coverage-threshold ERROR, no npm signal line,
# no unhandled error other than a vitest-worker RPC timeout, and no terminal error: a structural
# "Unhandled Error", "Startup Error" or "Collect Error" banner outside Vitest's counted block — how
# Vitest reports an exception thrown after the summary, such as a coverage-reporting failure, before it
# exits 1 (terminal_errors counts them; an RPC timeout never offsets one). RPC_ONLY means unhandled
# errors were present and EVERY one is such a timeout (OBS-1058: the starved 2-core runner talking,
# not a test).
#
# Which timeouts count: only one that is ITSELF an unhandled entry — the first payload line under a
# per-error header, nothing later. The header is Vitest's own structural line — a run of ⎯ on each side
# of "Unhandled Error", nothing else on the line — so prose that merely contains the words never opens
# a window, and the payload must be Vitest's whole line (`Error: [vitest-worker]: Timeout calling
# "<method>"`), so an assertion quoting it stays RED. Per-error headers are honoured only inside
# Vitest's own block — after its structural "Unhandled Errors" line and "Vitest caught N" tally, until
# the file summary — and each block's count never exceeds its N, so a test that prints a header and a
# timeout to stdout forges nothing. The tallies must also sum to the summaries' own "Errors N" lines
# (Vitest prints both from one list), so a forged or a missing block is RED as well.
set -u

log=${1:?log path required}
fields='summaries=0 passed=0 skipped=0 failed=0 timedout=0 unhandled=0 runner_rpc_timeouts=0 coverage_misses=0 signals=0 terminal_errors=0'
if [ ! -s "$log" ] || [ ! -r "$log" ]; then
  echo "VITEST_LOG verdict=RED reason=unreadable $fields"
  exit 1
fi

esc=$(printf '\033')
awk -v esc="$esc" '
  function num(s, word) { return match(s, "[0-9]+ " word) ? substr(s, RSTART, RLENGTH) + 0 : 0 }
  function close_block() { rpc += (found < cap ? found : cap); armed = 0; pending = 0 }
  {
    line = $0
    gsub(/\^\[\[[0-9;]*m/, "", line); gsub(esc "\\[[0-9;]*m", "", line)
    sub(/^[^\t]*\t[^\t]*\t[0-9T:.-]+Z[ ]?/, "", line)
  }
  # The Vitest timeout message carries its millisecond count; a test that PRINTS a fingerprint normalized
  # to #ms (the daemon OBS-1106 notifications) is output, not a timed-out test. A real timeout also fails
  # its test, so the summary failed count still reds it.
  line ~ /(Test|Hook) timed out in [0-9]+ ?ms/ { timedout++ }
  line ~ /ERROR: Coverage for .* does not meet .*threshold/ { coverage++ }
  line ~ /^npm (error|ERR!) signal / { signals++ }
  line ~ /^(⎯)+ Unhandled Errors (⎯)+[ \t]*$/ { if (armed) close_block(); opening = 1; next }
  opening && line !~ /[^ \t]/ { next }
  opening {
    opening = 0
    if (line ~ /^Vitest caught [0-9]+ unhandled error/) { armed = 1; found = 0; cap = num(line, "unhandled"); tally += cap }
    else untallied++
  }
  line ~ /^[ \t]*Test Files[ \t]/ {
    if (armed) close_block()
    summaries++; in_summary = 1; saw_tests = 0
    failed += num(line, "failed"); passed += num(line, "passed"); skipped += num(line, "skipped")
    next
  }
  in_summary && line ~ /^[ \t]*Tests[ \t]/ { saw_tests = 1; failed_tests += num(line, "failed"); next }
  in_summary && line ~ /^[ \t]*Errors[ \t]+[0-9]+ error/ { summary_errors += num(line, "error"); next }
  in_summary && line ~ /^[ \t]*Duration[ \t]/ { if (saw_tests) complete++; in_summary = 0; next }
  armed && line ~ /^(⎯)+ Unhandled Error (⎯)+[ \t]*$/ { pending = 1; next }
  line ~ /^(⎯)+ (Unhandled|Startup|Collect) Error (⎯)+[ \t]*$/ { terminal++; next }
  pending && line ~ /[^ \t]/ { pending = 0; if (line ~ /^Error: \[vitest-worker\]: Timeout calling "[A-Za-z]+"[ \t]*$/) found++ }
  END {
    unhandled = tally + untallied
    if (summary_errors > unhandled) unhandled = summary_errors
    other = unhandled - rpc
    if (summaries == 0) reason = "no-summary"
    else if (complete != summaries || opening || armed) reason = "truncated"
    else if (failed || failed_tests) reason = "failed"
    else if (timedout) reason = "timed-out"
    else if (coverage) reason = "coverage-threshold"
    else if (signals) reason = "signal"
    else if (terminal) reason = "terminal-error"
    else if (other > 0) reason = "unhandled-error"
    else if (tally + untallied != summary_errors) reason = "unhandled-mismatch"
    verdict = reason != "" ? "RED" : (unhandled > 0 ? "RPC_ONLY" : "CLEAN")
    if (reason == "") reason = "none"
    printf "VITEST_LOG verdict=%s reason=%s summaries=%d passed=%d skipped=%d failed=%d timedout=%d unhandled=%d runner_rpc_timeouts=%d coverage_misses=%d signals=%d terminal_errors=%d\n", \
      verdict, reason, summaries, passed, skipped, failed, timedout, other, rpc, coverage, signals, terminal
    exit (verdict == "RED")
  }
' "$log"
