#!/usr/bin/env bash
# run-ci-vitest.sh <log> <command...> — run one public-CI Vitest invocation, tee its output to <log>,
# and exit with the command's OWN status (pipefail semantics, as the step had before) unless the shared
# classifier proves the complete RPC-only exception (OBS-1184): the command exited exactly 1 and the
# log is a complete run whose only unhandled errors are vitest-worker RPC timeouts (OBS-1058). grade-ci.sh
# grades with the same classifier, so the CI badge and the grade agree. A signal or any other nonzero
# status, a truncated log, a coverage-threshold miss, a failed or timed-out test, or a missing classifier
# keeps the raw status. The count oracle (assert-test-file-count.sh) stays a separate step.
#
# "Complete" includes the run's declared contract (D-893: an RPC timeout once ended a run before its
# single-fork projects, and its log still read RPC_ONLY). The command declares its projects with its own
# --project argv; Vitest's own discovery (`npx vitest list --filesOnly`) in the candidate tree — this
# working directory — names the files those projects own, and their sum is the classifier's file count,
# so a never-started declared project is a short count: a log that collected fewer is RED reason=partial
# and keeps its 1, whatever its tests printed; so does a declared project discovery cannot find. A
# command that declares no project carries no contract. The callers pass nothing new.
set -uo pipefail

log=${1:?usage: run-ci-vitest.sh <log> <command...>}
shift
[ "$#" -gt 0 ] || { echo "run-ci-vitest: a command is required" >&2; exit 2; }
classifier="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills/tickmarkr-overseer/scripts/classify-vitest-log.sh"

projects=()
prev=
for arg in "$@"; do
  [ "$prev" = --project ] && projects+=("$arg")
  case "$arg" in --project=*) projects+=("${arg#--project=}") ;; esac
  prev=$arg
done

"$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
[ "${statuses[1]}" -eq 0 ] || exit "${statuses[1]}"
status=${statuses[0]}
[ "$status" -eq 1 ] || exit "$status"

contract=()
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

verdict=$(bash "$classifier" "$log" ${contract[@]+"${contract[@]}"} 2>&1)
case "$verdict" in
  "VITEST_LOG verdict=RPC_ONLY "*)
    echo "run-ci-vitest: exit 1 -> 0, every unhandled error is a vitest-worker RPC timeout: $verdict"
    exit 0 ;;
esac
echo "run-ci-vitest: exit 1 kept: ${verdict:-classifier produced no verdict}"
exit 1
