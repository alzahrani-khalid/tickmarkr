#!/usr/bin/env bash
# run-ci-vitest.sh <log> <command...> — run one public-CI Vitest invocation, tee its output to <log>,
# and exit with the command's OWN status (pipefail semantics, as the step had before) unless the shared
# classifier proves the complete RPC-only exception (OBS-1184): the command exited exactly 1 and the
# log is a complete run whose only unhandled errors are vitest-worker RPC timeouts (OBS-1058). grade-ci.sh
# grades with the same classifier, so the CI badge and the grade agree. A signal or any other nonzero
# status, a truncated log, a coverage-threshold miss, a failed or timed-out test, or a missing classifier
# keeps the raw status. The count oracle (assert-test-file-count.sh) stays a separate step.
#
# Every invocation first creates the log's parent directory and removes a stale record, then runs as
# `TICKMARKR_CI_RECORD=<log>.record.json <command...>` — a prefix, never exported — so the command's own
# Vitest writes its CI record (FORMAT F2) there and nothing else this script starts inherits the variable.
# If either step fails the command is never run and the exit is 2: a stale record must never pass for this run's.
#
# UNSHARDED (no token starts with --shard): "complete" includes the run's declared contract (D-893: an RPC
# timeout once ended a run before its single-fork projects, and its log still read RPC_ONLY). The command
# declares its projects with its own --project argv; Vitest's own discovery (`npx vitest list --filesOnly`)
# in the candidate tree — this working directory — names the files those projects own, and their sum is the
# classifier's file count, so a never-started declared project is a short count: a log that collected fewer
# is RED reason=partial and keeps its 1, whatever its tests printed or its record holds; so does a declared
# project discovery cannot find. An unsharded command that declares no project carries no count contract.
#
# SHARDED (any token starts with --shard; v2.7.8 T3, G5): a count can never hold a shard, so the shard's
# RECORD is held to its PLAN as a SET of {file, project} by `scripts/ci/cli.ts contract`, run through this
# checkout's own tsx as the classifier is found here. The command must match the CLOSED ARGV GRAMMAR —
# `npm run test:coverage -- <args>` or `npx vitest run <args>`, args being any `--project p`/`--project=p`
# and exactly one canonical `--shard=k/n`/`--shard k/n` — or the contract is UNREADABLE (defect kind argv):
# a positional filter, a second or noncanonical shard and any other flag included. The plan is T2's
# lptShards over scripts/ci/durations.json and Vitest's own discovery (`npx vitest list --filesOnly
# --json`) of those projects — every project when none is declared — which is the partition the root
# sequencer applied; the record's shard must equal the argument's. The contract is checked at status 0 AND 1:
#   status neither 0 nor 1                 -> that status
#   contract RED or UNREADABLE             -> 1 (a missing, unexpected, duplicate or unfinished file, an absent
#                                             record, an argv or shard-mismatch defect, a discovery failure)
#   contract GREEN, status 0               -> 0
#   contract GREEN, status 1               -> 0 only when the classifier, given the planned count, reads
#                                             RPC_ONLY; else 1
# So an unfiltered or incomplete shard is never laundered, a status-0 run over another shard's files is red,
# and a declared project that contributes no file to this shard owes none. The callers pass nothing new.
set -uo pipefail

log=${1:?usage: run-ci-vitest.sh <log> <command...>}
shift
[ "$#" -gt 0 ] || { echo "run-ci-vitest: a command is required" >&2; exit 2; }
checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
classifier="$checkout/skills/tickmarkr-overseer/scripts/classify-vitest-log.sh"
record="$log.record.json"

projects=()
sharded=
prev=
for arg in "$@"; do
  [ "$prev" = --project ] && projects+=("$arg")
  case "$arg" in
    --project=*) projects+=("${arg#--project=}") ;;
    --shard*) sharded=1 ;;
  esac
  prev=$arg
done

mkdir -p -- "$(dirname -- "$log")" || { echo "run-ci-vitest: cannot create the directory of $log; the command was not run" >&2; exit 2; }
rm -f -- "$record" || { echo "run-ci-vitest: cannot remove the stale record $record; the command was not run" >&2; exit 2; }
TICKMARKR_CI_RECORD="$record" "$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
[ "${statuses[1]}" -eq 0 ] || exit "${statuses[1]}"
status=${statuses[0]}

contract=()
if [ -n "$sharded" ]; then
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ] || exit "$status"
  shard_contract=$("$checkout/node_modules/.bin/tsx" "$checkout/scripts/ci/cli.ts" contract --record "$record" -- "$@")
  contract_status=$?
  [ -z "$shard_contract" ] || printf '%s\n' "$shard_contract"
  planned=$(printf '%s\n' "$shard_contract" | sed -n '$s|^SHARD_CONTRACT verdict=GREEN shard=[0-9]*/[0-9]* planned=\([0-9][0-9]*\) .*|\1|p')
  if [ "$contract_status" -ne 0 ] || [ -z "$planned" ]; then
    if [ "$status" -eq 1 ]; then echo "run-ci-vitest: exit 1 kept: the shard contract is not GREEN"
    else echo "run-ci-vitest: exit 0 -> 1: the shard contract is not GREEN"; fi
    exit 1
  fi
  [ "$status" -eq 1 ] || exit 0
  contract=("$planned")
  echo "run-ci-vitest: shard contract GREEN: $planned planned files"
else
  [ "$status" -eq 1 ] || exit "$status"
  if [ "${#projects[@]}" -gt 0 ]; then
    selection=()
    for project in "${projects[@]}"; do selection+=(--project "$project"); done
    if ! discovered=$(npx vitest list --filesOnly "${selection[@]}" 2>/dev/null); then
      echo "run-ci-vitest: exit 1 kept: candidate-tree discovery failed for ${projects[*]}"
      exit 1
    fi
    expected=0
    for project in "${projects[@]}"; do
      owned=$(printf '%s\n' "$discovered" | awk -v label="[$project] " 'index($0, label) == 1 { n++ } END { print n + 0 }')
      if [ "$owned" -eq 0 ]; then
        echo "run-ci-vitest: exit 1 kept: candidate-tree discovery found no test file for declared project $project"
        exit 1
      fi
      expected=$((expected + owned))
    done
    contract=("$expected")
    echo "run-ci-vitest: declared contract: $expected files across $(IFS=,; printf '%s' "${projects[*]}")"
  fi
fi

verdict=$(bash "$classifier" "$log" ${contract[@]+"${contract[@]}"} 2>&1)
case "$verdict" in
  "VITEST_LOG verdict=RPC_ONLY "*)
    echo "run-ci-vitest: exit 1 -> 0, every unhandled error is a vitest-worker RPC timeout: $verdict"
    exit 0 ;;
esac
echo "run-ci-vitest: exit 1 kept: ${verdict:-classifier produced no verdict}"
exit 1
