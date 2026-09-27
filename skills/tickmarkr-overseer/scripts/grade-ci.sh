#!/bin/bash
# grade-ci.sh <run-id> <expected-count> [tag] — grade both public CI jobs from their JOB LOGS.
# Grade only at run-end. A missing/in-progress/empty log is UNREADABLE, never evidence of green.
# Tri-state: exit 0 GREEN, 1 RED, 2 UNREADABLE. UNREADABLE dominates a mixed result.
set -u

run=${1:?run id required}
expected=${2:?expected tracked test-file count required}
tag=${3:-$run}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=${TKR_GRADE_CI_REPO:-alzahrani-khalid/tickmarkr}
out_dir=${TKR_GRADE_CI_DIR:-${TKR_STATE_DIR:-.tickmarkr}/overseer/diag}
mkdir -p "$out_dir" || { echo "UNREADABLE: cannot create log directory $out_dir"; exit 2; }

verdict=0
mark_unreadable() { verdict=2; }
mark_red() { [ "$verdict" -eq 0 ] && verdict=1; }
field() { printf '%s\n' "$classified" | sed -n "s/^VITEST_LOG.* $1=\([^ ]*\).*/\1/p"; }

jobs=$(gh run view "$run" --repo "$repo" --json jobs \
  --jq '.jobs[] | [.databaseId, .name, .status, (.conclusion // "")] | @tsv') \
  || { echo "UNREADABLE: job list"; exit 2; }
[ -n "$jobs" ] || { echo "UNREADABLE: empty job list"; exit 2; }

seen_test=0
seen_macos=0
while IFS=$'\t' read -r id name status conclusion; do
  case "$name" in
    test) seen_test=1 ;;
    test-macos) seen_macos=1 ;;
    *) continue ;;
  esac

  echo "$name: status=$status conclusion=${conclusion:-none} job=$id"
  if [ "$status" != "completed" ]; then
    echo "$name: UNREADABLE (job has not reached run-end)"
    mark_unreadable
    continue
  fi

  log="$out_dir/CI-$tag-$name.log"
  gh run view --repo "$repo" --job "$id" --log > "$log" 2>/dev/null
  if [ ! -s "$log" ]; then
    echo "$name: UNREADABLE (empty log)"
    mark_unreadable
    continue
  fi

  oracle=$(grep -oE 'COUNT_ORACLE [A-Z]+ expected=[0-9A-Z]+ actual=[0-9A-Z]+' "$log" | tail -1)
  files=$(grep -oE 'Test Files .*' "$log" | sed 's/[[:space:]]*$//')
  # OBS-1184: the log verdict comes from the ONE classifier the public CI wrapper also uses
  # (scripts/run-ci-vitest.sh), so the badge and this grade cannot disagree. Its rules — complete
  # summaries, failed/timed-out tests, coverage-threshold misses, and the RPC-timeout-only exception
  # to "any unhandled error is RED" (OBS-1058) — live in classify-vitest-log.sh, stated once there.
  classified=$(bash "$here/classify-vitest-log.sh" "$log" 2>&1)
  log_verdict=$(field verdict)
  passed=$(field passed); skipped=$(field skipped); failed=$(field failed); timedout=$(field timedout)
  unhandled=$(field unhandled); rpc=$(field runner_rpc_timeouts); coverage=$(field coverage_misses)
  errors=$(grep -oE '##\[error\].*' "$log" | sort | uniq -c | sed 's/^ *//' | tr '\n' ';')
  # The commands' own outcomes stand, as in the wrapper: GREEN needs a success conclusion with no step
  # exit annotation, or a failure explained ONLY by steps that exited exactly 1 on a log of their own
  # (gh's step column) that the classifier calls RPC_ONLY — the one exception run-ci-vitest.sh grants
  # (a pre-wrapper run concludes failure on it). Any other code (2, a signal's 137), an unexplained
  # failure, or a cancelled, timed-out or missing conclusion is RED.
  exits=$(grep -E '##\[error\]Process completed with exit code [0-9]+' "$log")
  case "$conclusion" in
    success) outcome=ok ;;
    failure) if [ -n "$exits" ]; then outcome=ok; else outcome=unexplained-failure; fi ;;
    *) outcome="conclusion-${conclusion:-none}" ;;
  esac
  if [ -n "$exits" ]; then
    while IFS= read -r exit_line; do
      code=$(printf '%s\n' "$exit_line" | sed -E 's/.*Process completed with exit code ([0-9]+).*/\1/')
      if [ "$code" != 1 ]; then outcome="exit-$code"; break; fi
      step=$(printf '%s\n' "$exit_line" | awk -F'\t' 'NF >= 3 { print $2 }')
      awk -F'\t' -v s="$step" 'NF >= 3 && $2 == s' "$log" > "$log.step"
      case $(bash "$here/classify-vitest-log.sh" "$log.step" 2>&1) in
        "VITEST_LOG verdict=RPC_ONLY "*) ;;
        *) outcome="exit-1-not-rpc-only"; break ;;
      esac
    done <<< "$exits"
  fi

  echo "$name: oracle=[${oracle:-MISSING}] files=[$(printf '%s' "$files" | tr '\n' '|')] passed=$passed skipped=$skipped failed=$failed timedout=$timedout unhandled=$unhandled runner_rpc_timeouts=$rpc coverage_misses=$coverage log=[$(field reason)] outcome=[$outcome] errors=[$errors]"
  if [ -z "$oracle" ] || [ -z "$files" ] || [ -z "$log_verdict" ]; then
    echo "$name: UNREADABLE"
    mark_unreadable
  elif [ "$oracle" = "COUNT_ORACLE GREEN expected=$expected actual=$expected" ] \
       && { [ "$log_verdict" = CLEAN ] || [ "$log_verdict" = RPC_ONLY ]; } && [ "$outcome" = ok ] \
       && [ $((passed + skipped)) -eq "$expected" ]; then
    echo "$name: GREEN"
  else
    echo "$name: RED"
    mark_red
  fi
done <<< "$jobs"

if [ "$seen_test" -ne 1 ]; then
  echo "test: UNREADABLE (job missing from run)"
  mark_unreadable
fi
if [ "$seen_macos" -ne 1 ]; then
  echo "test-macos: UNREADABLE (job missing from run)"
  mark_unreadable
fi

echo "VERDICT rc=$verdict (0=all GREEN 1=RED 2=UNREADABLE)"
exit "$verdict"
