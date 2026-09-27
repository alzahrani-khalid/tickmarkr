#!/usr/bin/env bash
# run-ci-vitest.sh <log> <command...> — run one public-CI Vitest invocation, tee its output to <log>,
# and exit with the command's OWN status (pipefail semantics, as the step had before) unless the shared
# classifier proves the complete RPC-only exception (OBS-1184): the command exited exactly 1 and the
# log is a complete run whose only unhandled errors are vitest-worker RPC timeouts (OBS-1058). grade-ci.sh
# grades with the same classifier, so the CI badge and the grade agree. A signal or any other nonzero
# status, a truncated log, a coverage-threshold miss, a failed or timed-out test, or a missing classifier
# keeps the raw status. The count oracle (assert-test-file-count.sh) stays a separate step.
set -uo pipefail

log=${1:?usage: run-ci-vitest.sh <log> <command...>}
shift
[ "$#" -gt 0 ] || { echo "run-ci-vitest: a command is required" >&2; exit 2; }
classifier="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills/tickmarkr-overseer/scripts/classify-vitest-log.sh"

"$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
[ "${statuses[1]}" -eq 0 ] || exit "${statuses[1]}"
status=${statuses[0]}
[ "$status" -eq 1 ] || exit "$status"

verdict=$(bash "$classifier" "$log" 2>&1)
case "$verdict" in
  "VITEST_LOG verdict=RPC_ONLY "*)
    echo "run-ci-vitest: exit 1 -> 0, every unhandled error is a vitest-worker RPC timeout: $verdict"
    exit 0 ;;
esac
echo "run-ci-vitest: exit 1 kept: ${verdict:-classifier produced no verdict}"
exit 1
