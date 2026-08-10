#!/bin/bash
# watch-parks.sh — wake the AUTHORITY seat on the one event that cannot proceed without it.
#
# A `task-human` park is a decision, and a decision is this seat's column. Every other tier can keep
# working around a park; the park itself waits for a ruling and nothing else releases it.
#
# WHY THIS EXISTS, 2026-08-07: this seat shipped an auto-supersede so a stalled orchestrator would stop
# needing it. That worked — ten interventions, pipeline moving, no wakes. But its only remaining wake was
# an artifact watcher pointed at a run-end file THAT HAD ALREADY BEEN WRITTEN, and a watcher whose trigger
# has passed is not coverage, it is a process that will never fire. A park was then found only because the
# seat happened to look — NO watcher covered parks at all.
#
# **Automating an unblock removes your NOTIFICATION without removing your RESPONSIBILITY.** Every time you
# make a tier need you less, re-ask what still needs you and arm for that.
#
# ⚠ The first version of this comment claimed the park sat "THREE HOURS AND THIRTEEN MINUTES". It sat TEN.
# The author compared UTC journal timestamps against a local wall clock (+03) and shipped the error inside
# a self-criticism — the one sentence nobody audits, including its writer. The gap is real and the watcher
# is justified by the ABSENCE OF COVERAGE, not by that number. See OBS-435.
#
# Prints ONE wake reason and exits. Re-arm after every wake.
#
# usage: watch-parks.sh <runs-dir> [poll-s] [cap-s]
#   Tracks the NEWEST run directory, so it follows a resume or a fresh run without being re-aimed.

set -u
RUNS="${1:?runs dir required (e.g. .tickmarkr/runs)}"
POLL="${2:-45}"
CAP="${3:-28800}"

# `grep -c` EXITS 1 WHEN THE COUNT IS ZERO, while still printing `0`. So the idiom
# `n=$(grep -c PAT f || echo 0)` yields the two-line string "0\n0", and every later `[ "$n" -gt … ]`
# dies with `integer expression expected` and evaluates FALSE. Found 2026-08-07 by a positive control,
# not by use: this watcher fired correctly all day because it was always armed on a journal that ALREADY
# held a park, which is the branch where grep exits 0. **Armed at the start of a run — zero parks — it
# could never report the first park, which is the one it exists for.** A guard whose failure is silence
# needs a control; this one had shipped without one.
count_parks() {
  local c
  c=$(grep -c '"event":"task-human"' "$1" 2>/dev/null || true)
  printf '%s' "${c:-0}"
}

newest_journal() {
  local d
  d=$(ls -t "$RUNS" 2>/dev/null | grep '^run-' | head -1)
  [ -n "$d" ] && [ -f "$RUNS/$d/journal.jsonl" ] && printf '%s' "$RUNS/$d/journal.jsonl"
}

# Seed on the CURRENT park count so we wake on the next one, not on history already ruled.
J=$(newest_journal)
seen=0
[ -n "${J:-}" ] && seen=$(count_parks "$J")
seen_run="${J:-}"

# ...and seed a LINE POSITION, because the park counter is not enough (evidence rule 30).
# `run-end` is a HISTORICAL RECORD once written. A whole-file grep for it finds the PREVIOUS run-end
# on every resume, and on any re-arm after a run has ended — so the watcher exits in its first poll,
# a supervisor re-execs it into the same instant exit, and the process table shows coverage that does
# not exist. Measured 2026-08-07: re-arming this watcher after run 264's run-end would have done
# exactly that. Only lines appended AFTER arming are evidence about now.
base=0
[ -n "${J:-}" ] && base=$(wc -l < "$J" 2>/dev/null || echo 0)
since_arm() { tail -n +$((base + 1)) "$1" 2>/dev/null; }

elapsed=0
while [ "$elapsed" -lt "$CAP" ]; do
  sleep "$POLL"
  elapsed=$((elapsed + POLL))

  J=$(newest_journal)
  [ -z "${J:-}" ] && continue

  # A new run resets the baseline — its parks AND its whole journal are unseen by definition.
  if [ "$J" != "$seen_run" ]; then seen=0; seen_run="$J"; base=0; fi

  now=$(count_parks "$J")
  if [ "$now" -gt "$seen" ]; then
    echo "PARK $((now - seen)) new — $(basename "$(dirname "$J")")"
    grep '"event":"task-human"' "$J" 2>/dev/null | tail -n "$((now - seen))" \
      | sed -n 's/.*"taskId":"\([^"]*\)".*"reason":"\([^"]\{0,160\}\).*/  \1: \2/p'
    echo "  a park waits for a RULING and nothing else releases it — read the gate evidence, then rule"
    exit 0
  fi

  # A run that ended is also this seat's business: the milestone verdict is a decision.
  # Scoped to lines appended since arming — see the `base` comment above.
  if since_arm "$J" | grep -q '"event":"run-end"'; then
    tv=$(since_arm "$J" | grep '"event":"run-end"' | tail -1 | sed -n 's/.*"tipVerify":"\([a-z]*\)".*/\1/p')
    echo "RUN_END $(basename "$(dirname "$J")") tipVerify=${tv:-unknown}"
    echo "  read tipVerify as a FIELD; a failing verify is a DIFFERENT event with no pass field"
    exit 0
  fi
done

echo "WATCH_CAP_REACHED — no new park or run-end in ${CAP}s (newest: $(basename "$(dirname "${J:-none/none}")"))"
