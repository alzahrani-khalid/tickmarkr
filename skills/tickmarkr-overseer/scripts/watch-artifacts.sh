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
#
# TKR_CLOSE_PANES="w1:p1,w1:p2" closes those panes when every artifact completes — the answer to panes
# accumulating because nobody was watching for "this seat is finished". It fires ONLY on completion,
# never on timeout. Operator-observed 2026-08-06: five consult panes in one tab left each 14 columns
# wide and unreadable, because closing was a step someone had to remember.
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

# A file is DONE when the marker appears in its last few lines AND the file has stopped growing.
#
# Anchored to the tail on purpose: a report that merely *mentions* its own marker mid-body has not
# finished, and grepping the whole file would call that done. This brief tells seats to end the file with
# the marker, so the tail is where it must be.
#
# ⚠ THE MARKER ALONE IS NOT COMPLETION, AND THIS COST A RULING. Measured 2026-08-07: a consult report was
# recorded here at 46,365 bytes WITH its terminal marker at 13:19:03. The seat then kept working — its
# source had moved again — and at 13:20:10 it rewrote its own summary line from `23 WEAK · 19 SOUND` to
# `25 WEAK · 17 SOUND`, leaving the marker last. The supervising seat read the earlier version, quoted it
# faithfully into a binding ruling, and shipped the superseded numbers. **A marker asserts "the file ends
# with X", which a file still being REVISED satisfies perfectly** — rewrite-in-place keeps the marker
# terminal at every instant. The failure is silent and reads exactly like a finished artifact.
#
# TWO THINGS ARE DONE ABOUT IT, AND ONLY ONE OF THEM IS A MECHANISM.
#
# 1. A stability check: the file's CONTENT HASH must be unchanged across two consecutive polls. This
#    reduces early wakes and costs one poll interval.
# 2. The wake line PRINTS THE HASH it fired on.
#
# **The stability check does NOT establish finality, and the drill proved it cannot.** A seat that pauses
# longer than one poll interval is indistinguishable from a finished one — and in the incident above the
# pause was 67 seconds against a 45-second poll, so *this check would not have prevented it either*. That
# is not a tuning problem: "has stopped writing" is unknowable from the file, because the information
# lives with the seat. Widening the window only trades one silent failure for latency and a stronger
# false impression of coverage, which is this project's worst class.
#
# **So the load-bearing half is the printed hash, and it is a READER contract, not a watcher feature:**
# re-hash the artifact when you quote it, and put that hash in whatever you write. If it differs from the
# wake's, you are reading a superseded file. That is the discipline the supervising seat had already
# imposed on the seat one level down — record the hash, re-check before writing — and skipped for itself.
# Signatures are held in an INDEXED array parallel to "$@", not an associative one keyed by path:
# `declare -A` is bash 4+, macOS ships bash 3.2, and `bash -n` accepts it happily — the failure is at
# RUNTIME, where the arithmetic then errors, `done_file` returns 1 forever, and the watcher never wakes.
# Caught by the drill below, not by the syntax check. A syntax check is not a positive control.
PREV=()
done_file() {                  # $1 = index into "$@", $2 = path
  local i="$1" f="$2" sig
  [ -s "$f" ] || return 1
  tail -5 "$f" 2>/dev/null | grep -qF -- "$MARKER" || return 1
  # CONTENT HASH, not size+mtime. The first version of this used `stat` size and mtime and the drill
  # killed it on the incident's own shape: the correction that cost a ruling was `23 WEAK · 19 SOUND`
  # -> `25 WEAK · 17 SOUND`, which is **byte-identical in length**, and mtime is whole seconds. A
  # signature that cannot see an equal-length in-place edit is blind to exactly the edit this exists to
  # catch. Hashing 48KB per poll costs nothing.
  sig=$(shasum -a 1 "$f" 2>/dev/null | cut -d' ' -f1)
  [ -n "$sig" ] || return 1
  if [ "${PREV[$i]:-}" = "$sig" ]; then return 0; fi
  PREV[$i]="$sig"              # marked but still moving — hold it one more poll
  return 1
}

while :; do
  pending=()
  ready=()
  i=0
  for f in "$@"; do
    if done_file "$i" "$f"; then ready+=("$f"); else pending+=("$f"); fi
    i=$((i + 1))
  done

  # TKR_WAKE_ON_ANY: wake as soon as ANY artifact completes, naming what is still outstanding.
  #
  # Measured 2026-08-07: three consultants were watched as one set. Two produced COMPLETE 30.9KB and
  # 22.2KB verdicts; the third sat BLOCKED on a permission prompt and never wrote a byte. The watcher
  # stayed silent — correctly, by its own all-or-nothing contract — and two finished verdicts went unread
  # until the operator asked. **An all-or-nothing watcher is hostage to its deadest member**, and the more
  # seats you watch the likelier one of them is stuck. This is OBS-369 recurring through a mechanism the
  # original fix did not cover: that fix keyed on the marker, which was right, and assumed the set
  # completes together, which is not.
  #
  # Default stays all-or-nothing so existing arms are unchanged. For a fan-out of independent seats,
  # WAKE_ON_ANY is the correct mode and the outstanding list tells you what to re-arm on.
  if [ "${TKR_WAKE_ON_ANY:-0}" = "1" ] && [ "${#ready[@]}" -gt 0 ]; then
    echo "WAKE: ${#ready[@]} of $# artifact(s) complete with marker '$MARKER' — ${#pending[@]} still outstanding"
    for f in ${ready[@]+"${ready[@]}"};   do echo "  READY       $(wc -c <"$f" | tr -d ' ') bytes  sha1 $(shasum -a 1 "$f" | cut -c1-12)  $f"; done
    for f in ${pending[@]+"${pending[@]}"}; do
      if [ -s "$f" ]; then echo "  PARTIAL     $(wc -c <"$f" | tr -d ' ') bytes, no marker yet  $f  last-line: $(tail -n 1 "$f" | tr -d '\0' | cut -c1-72)"
      else echo "  NOT STARTED $f  <- check whether that seat is BLOCKED; a stalled seat writes nothing"; fi
    done
    exit 0
  fi

  if [ "${#pending[@]}" -eq 0 ]; then
    echo "WAKE: all ${#ready[@]} artifact(s) complete with marker '$MARKER'"
    for f in ${ready[@]+"${ready[@]}"}; do echo "  READY  $(wc -c <"$f" | tr -d ' ') bytes  sha1 $(shasum -a 1 "$f" | cut -c1-12)  $f"; done
    echo "  RE-HASH BEFORE YOU QUOTE IT. The marker means the file ENDS with '$MARKER', never that its"
    echo "  author has stopped: a rewrite-in-place keeps the marker terminal at every instant. If shasum"
    echo "  now differs from the value above, you are reading a superseded file."
    # A seat whose artifact is COMPLETE has nothing left to give: the report is the archive, the pane is
    # not. Closing here is safe precisely because the marker — not `done`, not a size — is the trigger,
    # so this can never reap a seat mid-write. Only on the COMPLETE path: on a timeout the seats are
    # still working and closing one would destroy the work being waited for.
    if [ -n "${TKR_CLOSE_PANES:-}" ]; then
      for pane in ${TKR_CLOSE_PANES//,/ }; do
        # `herdr pane close` exits 0 even for a pane that is already gone, so report the body rather
        # than the status — an exit code here would claim a close that may never have happened.
        printf '  CLOSED %s -> %s\n' "$pane" "$(herdr pane close "$pane" 2>&1 | head -c 80)"
      done
    fi
    exit 0
  fi

  if [ "$SECONDS" -ge "$END" ]; then
    # Timing out is NOT failure and must not read as one: it is the heartbeat that proves the watcher was
    # alive and still watching. Report both sides so the state is unambiguous on arrival.
    echo "WAKE: cap ${CAP}s reached — ${#ready[@]} of $# complete, re-arm"
    for f in ${ready[@]+"${ready[@]}"};   do echo "  READY    $(wc -c <"$f" | tr -d ' ') bytes  $f"; done
    for f in ${pending[@]+"${pending[@]}"}; do
      # PARTIAL prints the file's ACTUAL last line: a seat that reports the wrong marker for its own
      # artifact leaves the file complete while this watcher waits forever, and the mismatch is visible
      # only here (measured 2026-08-17: demanded/reported `SWEEP-END`, written `ORDER4-END`).
      if [ -s "$f" ]; then echo "  PARTIAL  $(wc -c <"$f" | tr -d ' ') bytes, no '$MARKER' yet  $f  last-line: $(tail -n 1 "$f" | tr -d '\0' | cut -c1-72)"
      else echo "  ABSENT   $f"; fi
    done
    exit 0
  fi

  sleep "$POLL"
done
