#!/bin/bash
# grade-ci.sh <run-id> <expected-count> [tag] — grade both public CI jobs from their JOB LOGS.
# Grade only at run-end. A missing/in-progress/empty log is UNREADABLE, never evidence of green.
# Tri-state: exit 0 GREEN, 1 RED, 2 UNREADABLE. UNREADABLE dominates a mixed result.
set -u

run=${1:?run id required}
expected=${2:?expected tracked test-file count required}
tag=${3:-$run}
repo=${TKR_GRADE_CI_REPO:-alzahrani-khalid/tickmarkr}
out_dir=${TKR_GRADE_CI_DIR:-${TKR_STATE_DIR:-.tickmarkr}/overseer/diag}
mkdir -p "$out_dir" || { echo "UNREADABLE: cannot create log directory $out_dir"; exit 2; }

verdict=0
mark_unreadable() { verdict=2; }
mark_red() { [ "$verdict" -eq 0 ] && verdict=1; }

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
  passed=$(printf '%s\n' "$files" | grep -oE '[0-9]+ passed' | awk '{s+=$1} END{print s+0}')
  skipped=$(printf '%s\n' "$files" | grep -oE '[0-9]+ skipped' | awk '{s+=$1} END{print s+0}')
  failed=$(printf '%s\n' "$files" | grep -oE '[0-9]+ failed' | awk '{s+=$1} END{print s+0}')
  timedout=$(grep -cE 'Test timed out|Error: Hook timed out' "$log" || true)
  errors=$(grep -oE '##\[error\].*' "$log" | sort | uniq -c | sed 's/^ *//' | tr '\n' ';')

  echo "$name: oracle=[${oracle:-MISSING}] files=[$(printf '%s' "$files" | tr '\n' '|')] passed=$passed skipped=$skipped failed=$failed timedout=$timedout errors=[$errors]"
  if [ -z "$oracle" ] || [ -z "$files" ]; then
    echo "$name: UNREADABLE"
    mark_unreadable
  elif [ "$oracle" = "COUNT_ORACLE GREEN expected=$expected actual=$expected" ] \
       && [ "$failed" -eq 0 ] && [ "$timedout" -eq 0 ] \
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
