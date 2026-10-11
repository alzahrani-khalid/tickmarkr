#!/bin/bash
# grade-ci.sh <run-id> <expected-count> [tag] — grade EVERY job of a public CI run's closed inventory from
# its JOB LOG. Grade only at run-end. A missing/in-progress/empty log is UNREADABLE, never evidence of green.
# Exit 0 GREEN, 1 RED, 2 UNREADABLE, 3 INFRA_KILLED: a job the GitHub runner shut down or cancelled with
# no failed or timed-out test (the classifier's class, D-897) — never green, never a pass, only unproven.
# UNREADABLE dominates a mixed result, then RED: a failure anywhere dominates a kill.
#
# Two CLOSED inventories (v2.7.8 T4; the workflow renders these names): serial {test, test-macos}; sharded,
# for os in ubuntu-latest and macos-latest, `suite <os> k/4` for k 1..4, `single-fork <os>`, `aggregate <os>`.
# A run holding any sharded name is graded against the sharded inventory, else the serial one. The first
# line is `INVENTORY form=<serial|sharded> declared=<n> observed=<n>`; each missing, duplicated or unknown
# name prints `INVENTORY_DEFECT kind=<missing|duplicate|unknown> job=<json-quoted name>` and makes the run
# UNREADABLE: a job the inventory does not name is never skipped.
#
# A verdict line is read only from the log lines whose gh step column equals its declared step, exactly
# once, else UNREADABLE — a line a test or any other step prints, before or after the real one, never decides:
#   COUNT_ORACLE <GREEN|RED> expected=<n|UNREADABLE> actual=<n|UNREADABLE>   step `Assert collected test-file count`
#   COVERAGE_FLOORS verdict=… floors=… failing=…  (T1's final floors line)   step `Recheck coverage floors`
#   SET_ORACLE verdict=… expected=… actual=… defects=…  (T3's set oracle)     step `Assert collected test-file set`
# ROLES — the shared classifier (classify-vitest-log.sh) stays the one log verdict:
#   serial       the base rule (count oracle GREEN at the expected count, the classifier given that count
#                reading CLEAN or RPC_ONLY, passed+skipped equal to it) AND exactly one COVERAGE_FLOORS
#                verdict=GREEN, so a dropped floors step reads UNREADABLE.
#   shard, single-fork
#                GREEN only on conclusion success whose whole log the classifier, given no count, reads CLEAN
#                or RPC_ONLY: their wrapper already applied the shard contract in-job.
#   aggregate    GREEN only on conclusion success with exactly one COVERAGE_FLOORS verdict=GREEN, exactly one
#                `SET_ORACLE verdict=GREEN expected=N actual=N defects=0`, and the lines of its step
#                `Merge coverage (one threshold check per OS)` classified CLEAN or RPC_ONLY.
# Exit annotations: SERIAL keeps the one exception run-ci-vitest.sh grants (a failure explained ONLY by steps
# that exited exactly 1 on a log of their own the classifier reads RPC_ONLY); any other failing annotation is
# never GREEN. Shard, single-fork and aggregate admit none — their wrapper applied the exception in-job.
# INFRA_KILLED is the base rule for every role.
set -u

run=${1:?run id required}
expected=${2:?expected tracked test-file count required}
tag=${3:-$run}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=${TKR_GRADE_CI_REPO:-alzahrani-khalid/tickmarkr}
out_dir=${TKR_GRADE_CI_DIR:-${TKR_STATE_DIR:-.tickmarkr}/overseer/diag}
mkdir -p "$out_dir" || { echo "UNREADABLE: cannot create log directory $out_dir"; exit 2; }

serial_inventory=$'test\ntest-macos'
sharded_inventory=$(for os in ubuntu-latest macos-latest; do
  for k in 1 2 3 4; do echo "suite $os $k/4"; done
  echo "single-fork $os"
  echo "aggregate $os"
done)
COUNT_STEP="Assert collected test-file count"
FLOORS_STEP="Recheck coverage floors"
SET_STEP="Assert collected test-file set"
MERGE_STEP="Merge coverage (one threshold check per OS)"
COUNT_FORMAT='COUNT_ORACLE (GREEN|RED) expected=([0-9]+|UNREADABLE) actual=([0-9]+|UNREADABLE)'
FLOORS_FORMAT='COVERAGE_FLOORS verdict=(GREEN|RED|UNREADABLE) floors=([0-9]+|UNREADABLE) failing=([0-9]+|UNREADABLE)'
SET_FORMAT='SET_ORACLE verdict=(GREEN|RED|UNREADABLE) expected=([0-9]+|UNREADABLE) actual=([0-9]+|UNREADABLE) defects=[0-9]+'

verdict=0
mark_unreadable() { verdict=2; }
mark_red() { [ "$verdict" -eq 2 ] || verdict=1; }
mark_killed() { [ "$verdict" -ne 0 ] || verdict=3; }
field() { printf '%s\n' "$classified" | sed -n "s/^VITEST_LOG.* $1=\([^ ]*\).*/\1/p"; }
count() { printf '%s' "$1" | grep -c ''; }
# json <name> — one JSON string; awk -v decodes gh's @tsv escapes (\t \n \r \\) first
json() {
  LC_ALL=C awk -v s="$1" 'BEGIN {
    for (i = 1; i < 32; i++) esc[sprintf("%c", i)] = sprintf("\\u%04x", i)
    esc["\""] = "\\\""; esc["\\"] = "\\\\"
    for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); out = out (c in esc ? esc[c] : c) }
    print "\"" out "\""
  }'
}
defect() { echo "INVENTORY_DEFECT kind=$1 job=$(json "$2")"; mark_unreadable; }
# step_log <log> <step> — the job-log lines gh's step column attributes to <step>, as gh printed them
step_log() { awk -F'\t' -v s="$2" 'NF >= 3 && $2 == s' "$1"; }
# verdict_line <log> <step> <family> <format> — the ONE <family> line <step> printed, in <format>;
# else MISSING, MULTIPLE(n) or MALFORMED, each UNREADABLE
verdict_line() {
  local lines
  lines=$(step_log "$1" "$2" | awk -v esc="$(printf '\033')" '{
    gsub(/\^\[\[[0-9;]*m/, ""); gsub(esc "\\[[0-9;]*m", "")
    sub(/^[^\t]*\t[^\t]*\t[0-9T:.-]+Z ?/, ""); sub(/[ \t\r]+$/, ""); print
  }' | grep -E "^$3( |\$)")
  case $(count "$lines") in
    0) echo MISSING ;;
    1) if printf '%s\n' "$lines" | grep -qxE "$4"; then printf '%s\n' "$lines"; else echo MALFORMED; fi ;;
    *) echo "MULTIPLE($(count "$lines"))" ;;
  esac
}
readable() { case $1 in MISSING|MULTIPLE*|MALFORMED) return 1 ;; esac; }
floors_green() { printf '%s\n' "$1" | grep -qxE 'COVERAGE_FLOORS verdict=GREEN floors=[0-9]+ failing=0'; }

jobs=$(gh run view "$run" --repo "$repo" --json jobs \
  --jq '.jobs[] | [.databaseId, .name, .status, (.conclusion // "")] | @tsv') \
  || { echo "UNREADABLE: job list"; exit 2; }
# an empty job list is an inventory like any other: serial, observed=0, every declared job missing

names=$(printf '%s\n' "$jobs" | cut -f2)
if printf '%s\n' "$names" | grep -qxF -f <(printf '%s\n' "$sharded_inventory"); then
  form=sharded; declared=$sharded_inventory
else
  form=serial; declared=$serial_inventory
fi
echo "INVENTORY form=$form declared=$(count "$declared") observed=$(count "$names")"
while IFS= read -r name; do
  case $(printf '%s\n' "$names" | grep -cxF -- "$name") in
    0) defect missing "$name" ;;
    1) ;;
    *) defect duplicate "$name" ;;
  esac
done <<< "$declared"
while IFS= read -r name; do
  printf '%s\n' "$declared" | grep -qxF -- "$name" || defect unknown "$name"
done < <([ -z "$jobs" ] || printf '%s\n' "$names" | awk '!seen[$0]++')

[ -z "$jobs" ] || while IFS=$'\t' read -r id name status conclusion; do
  # an unknown job has no role to grade: its INVENTORY_DEFECT already made the run UNREADABLE
  printf '%s\n' "$declared" | grep -qxF -- "$name" || continue
  case "$name" in
    test|test-macos) role=serial ;;
    suite\ *) role=shard ;;
    single-fork\ *) role=single-fork ;;
    *) role=aggregate ;;
  esac

  echo "$name: role=$role status=$status conclusion=${conclusion:-none} job=$id"
  if [ "$status" != "completed" ]; then
    echo "$name: UNREADABLE (job has not reached run-end)"
    mark_unreadable
    continue
  fi

  log="$out_dir/CI-$tag-$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-').log"
  gh run view --repo "$repo" --job "$id" --log > "$log" 2>/dev/null
  if [ ! -s "$log" ]; then
    echo "$name: UNREADABLE (empty log)"
    mark_unreadable
    continue
  fi

  files=$(grep -oE 'Test Files .*' "$log" | sed 's/[[:space:]]*$//')
  # OBS-1184: the log verdict comes from the ONE classifier the public CI wrapper also uses
  # (scripts/run-ci-vitest.sh), so the badge and this grade cannot disagree. Its rules — complete
  # summaries, failed/timed-out tests, coverage-threshold misses, and the RPC-timeout-only exception
  # to "any unhandled error is RED" (OBS-1058) — live in classify-vitest-log.sh, stated once there.
  # A serial job's expected count is its declared file contract: both steps' summaries must collect it all.
  # A shard or single-fork job carries no count: its wrapper held it to its plan in-job.
  if [ "$role" = serial ]; then
    classified=$(bash "$here/classify-vitest-log.sh" "$log" "$expected" 2>&1)
  else
    classified=$(bash "$here/classify-vitest-log.sh" "$log" 2>&1)
  fi
  log_verdict=$(field verdict)
  passed=$(field passed); skipped=$(field skipped); failed=$(field failed); timedout=$(field timedout)
  unhandled=$(field unhandled); rpc=$(field runner_rpc_timeouts); coverage=$(field coverage_misses)
  kills=$(field runner_kills)
  errors=$(grep -oE '##\[error\].*' "$log" | sort | uniq -c | sed 's/^ *//' | tr '\n' ';')
  # The commands' own outcomes stand, as in the wrapper: GREEN needs a success conclusion with no step
  # exit annotation, or — SERIAL only — a failure explained ONLY by steps that exited exactly 1 on a log
  # of their own (gh's step column) that the classifier calls RPC_ONLY. Any other code (2, a signal's
  # 137), any annotation on another role, an unexplained failure, or a cancelled, timed-out or missing
  # conclusion is RED.
  exits=$(grep -E '##\[error\]Process completed with exit code [0-9]+' "$log")
  case "$conclusion" in
    success) outcome=ok ;;
    failure) if [ -n "$exits" ]; then outcome=ok; else outcome=unexplained-failure; fi ;;
    *) outcome="conclusion-${conclusion:-none}" ;;
  esac
  if [ -n "$exits" ]; then
    while IFS= read -r exit_line; do
      code=$(printf '%s\n' "$exit_line" | sed -E 's/.*Process completed with exit code ([0-9]+).*/\1/')
      if [ "$code" != 1 ] || [ "$role" != serial ]; then outcome="exit-$code"; break; fi
      step=$(printf '%s\n' "$exit_line" | awk -F'\t' 'NF >= 3 { print $2 }')
      step_log "$log" "$step" > "$log.step"
      case $(bash "$here/classify-vitest-log.sh" "$log.step" 2>&1) in
        "VITEST_LOG verdict=RPC_ONLY "*) ;;
        *) outcome="exit-1-not-rpc-only"; break ;;
      esac
    done <<< "$exits"
  fi

  oracles=
  case $role in
    serial)
      oracle=$(verdict_line "$log" "$COUNT_STEP" COUNT_ORACLE "$COUNT_FORMAT")
      floors=$(verdict_line "$log" "$FLOORS_STEP" COVERAGE_FLOORS "$FLOORS_FORMAT")
      oracles="oracle=[$oracle] floors=[$floors] " ;;
    aggregate)
      floors=$(verdict_line "$log" "$FLOORS_STEP" COVERAGE_FLOORS "$FLOORS_FORMAT")
      set_oracle=$(verdict_line "$log" "$SET_STEP" SET_ORACLE "$SET_FORMAT")
      step_log "$log" "$MERGE_STEP" > "$log.merge"
      merge=$(bash "$here/classify-vitest-log.sh" "$log.merge" 2>&1 | sed -n 's/^VITEST_LOG verdict=\([^ ]*\) reason=\([^ ]*\) .*/\1 \2/p')
      oracles="floors=[$floors] set=[$set_oracle] merge=[$merge] " ;;
  esac

  echo "$name: ${oracles}files=[$(printf '%s' "$files" | tr '\n' '|')] passed=$passed skipped=$skipped failed=$failed timedout=$timedout unhandled=$unhandled runner_rpc_timeouts=$rpc coverage_misses=$coverage runner_kills=${kills:-?} log=[$(field reason)] outcome=[$outcome] errors=[$errors]"
  # A killed runner skips the oracle steps, so a missing verdict line is the kill's, not an unreadable log:
  # INFRA_KILLED unless a step's own failing exit or a failed/timed-out test dominates it (then RED).
  if [ "$log_verdict" = INFRA_KILLED ] && [ "${outcome#exit-}" = "$outcome" ]; then
    echo "$name: INFRA_KILLED"
    mark_killed
    continue
  elif [ "${kills:-0}" -gt 0 ] 2>/dev/null; then
    grade=RED
  elif [ -z "$log_verdict" ]; then
    grade=UNREADABLE
  else
    case $log_verdict in CLEAN|RPC_ONLY) log_ok=1 ;; *) log_ok= ;; esac
    grade=RED
    case $role in
      serial)
        if ! readable "$oracle" || ! readable "$floors" || [ -z "$files" ]; then
          grade=UNREADABLE
        elif [ "$oracle" = "COUNT_ORACLE GREEN expected=$expected actual=$expected" ] && floors_green "$floors" \
             && [ -n "$log_ok" ] && [ "$outcome" = ok ] && [ $((passed + skipped)) -eq "$expected" ]; then
          grade=GREEN
        fi ;;
      shard|single-fork)
        if [ "$outcome" = ok ] && [ "$conclusion" = success ] && [ -n "$log_ok" ]; then grade=GREEN; fi ;;
      aggregate)
        if ! readable "$floors" || ! readable "$set_oracle"; then
          grade=UNREADABLE
        elif [ "$outcome" = ok ] && [ "$conclusion" = success ] && floors_green "$floors" \
             && [ "$set_oracle" = "SET_ORACLE verdict=GREEN expected=$expected actual=$expected defects=0" ] \
             && { [ "${merge%% *}" = CLEAN ] || [ "${merge%% *}" = RPC_ONLY ]; }; then
          grade=GREEN
        fi ;;
    esac
  fi
  echo "$name: $grade"
  case $grade in
    RED) mark_red ;;
    UNREADABLE) mark_unreadable ;;
  esac
done <<< "$jobs"

echo "VERDICT rc=$verdict (0=all GREEN 1=RED 2=UNREADABLE 3=INFRA_KILLED)"
exit "$verdict"
