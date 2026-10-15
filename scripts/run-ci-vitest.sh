#!/usr/bin/env bash
# run-ci-vitest.sh <log> <command...> — run one public-CI Vitest invocation, tee its output to <log>, and
# decide its exit from the invocation's OWN record (v2.8.2 T1, ANL-022 §7.1; queue row 148), never from the
# text the run printed. The badge (this exit) and the grade (grade-ci.sh, which downloads the same records
# once ANL-022 §7.2b ships) read the same record, so they cannot disagree; no text rule decides this exit.
#
# Every invocation first creates the log's parent directory and removes a stale record, then runs as
# `TICKMARKR_CI_RECORD=<log>.record.json <command...>` — a prefix, never exported — so the command's own
# Vitest writes its CI record (FORMAT F3, scripts/ci/reporter.ts) there and nothing else this script starts
# inherits the variable. If either step fails the command is never run and the exit is 2: a stale record must
# never pass for this run's.
#
# At status 0 and 1 two machine verdicts are computed through this checkout's own tsx and both lines print:
#   the record verdict  `scripts/ci/cli.ts verdict <record>`  -> RECORD_VERDICT CLEAN | RPC_ONLY | RED | UNREADABLE
#                       (RPC_ONLY: every unhandled error is an exact vitest-worker RPC timeout — name Error, the
#                       whole message `[vitest-worker]: Timeout calling "<m>"`, type Unhandled Error — and no
#                       file or test failed or stayed unfinished; an absent record is UNREADABLE)
#   the set contract    `scripts/ci/cli.ts contract --record <record> -- <command...>` -> SHARD_CONTRACT
#                       The command must match the CLOSED ARGV GRAMMAR — `npm run test:coverage -- <args>` or
#                       `npx vitest run <args>`, args being any `--project p`/`--project=p` and at most one
#                       canonical `--shard=k/n`/`--shard k/n` — or the contract is UNREADABLE (defect argv).
#                       UNSHARDED: the record's {file, project} set must equal Vitest's own discovery
#                       (`npx vitest list --filesOnly --json`) of the declared projects — every project when none
#                       is declared — and each declared project must own a discovered file, so a never-started
#                       project or an RPC timeout's stranded module (absent from the record) is RED.
#                       SHARDED: the record is held to its LPT plan over scripts/ci/durations.json and that
#                       discovery, the partition the root sequencer applied; the record's shard must equal the
#                       argument's.
# The status-versus-record table:
#   status neither 0 nor 1                          -> that status (a signal, a crash, a tee failure)
#   status 0, record CLEAN and contract GREEN       -> 0
#   status 1, record RPC_ONLY and contract GREEN    -> 0 (the complete RPC-only exception: the set is complete
#                                                     and every file in it passed or skipped)
#   status 0 or 1, anything else                    -> 1 (a RED, unfinished or interrupted record, a CLEAN record
#                                                     at status 1, an absent record, a RED or UNREADABLE contract)
# Coverage thresholds are the floors step's verdict (`cli.ts floors --out`), not this wrapper's. The callers
# pass nothing new.
set -uo pipefail

log=${1:?usage: run-ci-vitest.sh <log> <command...>}
shift
[ "$#" -gt 0 ] || { echo "run-ci-vitest: a command is required" >&2; exit 2; }
checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
record="$log.record.json"

mkdir -p -- "$(dirname -- "$log")" || { echo "run-ci-vitest: cannot create the directory of $log; the command was not run" >&2; exit 2; }
rm -f -- "$record" || { echo "run-ci-vitest: cannot remove the stale record $record; the command was not run" >&2; exit 2; }
TICKMARKR_CI_RECORD="$record" "$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
[ "${statuses[1]}" -eq 0 ] || exit "${statuses[1]}"
status=${statuses[0]}
[ "$status" -eq 0 ] || [ "$status" -eq 1 ] || exit "$status"

cli=("$checkout/node_modules/.bin/tsx" "$checkout/scripts/ci/cli.ts")
verdict_out=$("${cli[@]}" verdict "$record")
verdict_status=$?
[ -z "$verdict_out" ] || printf '%s\n' "$verdict_out"
contract_out=$("${cli[@]}" contract --record "$record" -- "$@")
contract_status=$?
[ -z "$contract_out" ] || printf '%s\n' "$contract_out"
verdict=$(printf '%s\n' "$verdict_out" | sed -n '$s/^RECORD_VERDICT verdict=\([A-Z_]*\) .*/\1/p')
contract=$(printf '%s\n' "$contract_out" | sed -n '$s/^SHARD_CONTRACT verdict=\([A-Z]*\) .*/\1/p')
# fail closed: a verdict word is believed only beside its own exit status
if [ "$verdict_status" -ne 0 ] && { [ "$verdict" = CLEAN ] || [ "$verdict" = RPC_ONLY ]; }; then verdict=UNREADABLE; fi
[ "$contract_status" -eq 0 ] || [ "$contract" != GREEN ] || contract=UNREADABLE

want=CLEAN
[ "$status" -eq 0 ] || want=RPC_ONLY
if [ "$verdict" = "$want" ] && [ "$contract" = GREEN ]; then
  echo "run-ci-vitest: exit $status -> 0: record ${verdict} and set contract GREEN"
  exit 0
fi
echo "run-ci-vitest: exit $status -> 1: record ${verdict:-UNREADABLE} (status $status needs $want) and set contract ${contract:-UNREADABLE} (needs GREEN)"
exit 1
