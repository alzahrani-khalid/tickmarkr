#!/bin/bash
# Wake the overseer when spawned seats have actually DELIVERED.
#
#   watch-artifacts.sh <marker> <cap-seconds> <poll-seconds> <file>...
#
# Completion is the ARTIFACT plus its TERMINAL MARKER — never an agent's `done`, which is turn end and
# fires the moment a seat finishes acknowledging you. Never file existence alone either: a seat killed
# mid-write leaves a large, plausible, truncated file. Size proves it started; the marker proves it
# finished. Measured 2026-08-06: one 10KB verdict was on disk while its seat still read `working`, and two
# 30KB/12.8KB verdicts sat COMPLETE for minutes with nothing watching, found only because the operator
# asked (OBS-369).
#
# ARM THIS IN THE SAME CALL THAT SPAWNS THE SEAT. A watcher armed later leaves an unwatched gap exactly as
# wide as however long you stay busy — and you will be busy, because you just spawned work.
#
# Prints one wake reason and EXITS. Re-arm after every wake.
set -u
# macOS ships bash 3.2, where `set -u` makes "${arr[@]}" on an EMPTY array a fatal unbound-variable
# error. Every expansion below therefore uses the ${arr[@]+"${arr[@]}"} guard. Caught by the timeout
# control, not by the completion one: the happy path was green while the path that runs on almost every
# arm crashed before printing its reason — a watcher that dies without a wake reason is the exact failure
# this script exists to prevent.

MARKER="${1:?usage: watch-artifacts.sh <marker> <cap-seconds> <poll-seconds> <file>...}"
CAP="${2:?}"
POLL="${3:?}"
shift 3
[ "$#" -gt 0 ] || { echo "watch-artifacts: no files given" >&2; exit 2; }

# Cap BELOW the host's background-job kill so every arm ends by PRINTING something. A job killed at the
# limit carries no wake reason and is indistinguishable from a real wake until you read the output —
# OBS-325, re-earned by a third watcher that had not been capped because the fix was applied only to the
# two that happened to be in view at the time. Class, not instance.
END=$((SECONDS + CAP))

# A file is DONE when the marker appears in its last few lines. Anchored to the tail on purpose: a report
# that merely *mentions* its own marker mid-body has not finished, and grepping the whole file would call
# that done. This brief tells seats to end the file with the marker, so the tail is where it must be.
done_file() {
  [ -s "$1" ] || return 1
  tail -5 "$1" 2>/dev/null | grep -qF -- "$MARKER"
}

while :; do
  pending=()
  ready=()
  for f in "$@"; do
    if done_file "$f"; then ready+=("$f"); else pending+=("$f"); fi
  done

  if [ "${#pending[@]}" -eq 0 ]; then
    echo "WAKE: all ${#ready[@]} artifact(s) complete with marker '$MARKER'"
    for f in ${ready[@]+"${ready[@]}"}; do echo "  READY  $(wc -c <"$f" | tr -d ' ') bytes  $f"; done
    exit 0
  fi

  if [ "$SECONDS" -ge "$END" ]; then
    # Timing out is NOT failure and must not read as one: it is the heartbeat that proves the watcher was
    # alive and still watching. Report both sides so the state is unambiguous on arrival.
    echo "WAKE: cap ${CAP}s reached — ${#ready[@]} of $# complete, re-arm"
    for f in ${ready[@]+"${ready[@]}"};   do echo "  READY    $(wc -c <"$f" | tr -d ' ') bytes  $f"; done
    for f in ${pending[@]+"${pending[@]}"}; do
      if [ -s "$f" ]; then echo "  PARTIAL  $(wc -c <"$f" | tr -d ' ') bytes, no '$MARKER' yet  $f"
      else echo "  ABSENT   $f"; fi
    done
    exit 0
  fi

  sleep "$POLL"
done
