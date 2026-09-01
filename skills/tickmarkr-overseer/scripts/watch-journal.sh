#!/bin/bash
# watch-journal.sh — wake on a run's TERMINAL and DECISION events, print one reason, and exit.
#
# WHY THIS EXISTS, 2026-08-31 (OBS-808): `tickmarkr-auto` and `tickmarkr-loop` both tell the operator to
# *"watch the run journal for its terminal event rather than polling"* — and neither skill shipped a single
# script. Correct instruction, no means to follow it, so the reader polls or sleeps through the run's end.
# Worse, `task-failed` and `consult-verdict` appeared in NO shipped script at all, while the overseer skill
# instructs seats to arm watchers on all four events. This is that instrument, for the reader who has no
# supervising tier.
#
# ⚠ It is NOT a second implementation of the scoping idiom: the arm-time line baseline below is
# `watch-parks.sh`'s, kept deliberately identical, because that file paid for two traps that a fresh
# implementation re-earns (see ARM-TIME SCOPING). `watch-parks.sh` remains the AUTHORITY seat's park
# watcher — it counts parks and speaks about rulings; this one is the general four-event watcher.
#
# usage: watch-journal.sh <runs-dir> [poll-s] [cap-s] [events-csv]
#   <runs-dir>    e.g. .tickmarkr/runs — tracks the NEWEST run directory, so it follows a resume or a
#                 fresh run without being re-aimed.
#   [events-csv]  default `run-end,task-human,task-failed,consult-verdict` — the four the overseer skill
#                 names. Narrow it only when you have a reason; a watcher on fewer events is less coverage
#                 wearing the same name.
#
# Prints ONE wake reason and exits. RE-ARM AFTER EVERY WAKE — the gap between a wake and its re-arm is
# unwatched, and its width is however long the reader stays busy.

set -u
RUNS="${1:?runs dir required (e.g. .tickmarkr/runs)}"
POLL="${2:-20}"
CAP="${3:-28800}"
EVENTS="${4:-run-end,task-human,task-failed,consult-verdict}"

# Config flows into a regex, so validate the shape rather than trusting it (an unquoted or unchecked
# event list is a shell/regex injection and a silently-never-matching pattern at the same time).
#
# ⚠ VALIDATE THE RAW INPUT, AND NEVER NORMALISE FIRST. An earlier draft ran `tr -d '[:space:]'` before
# this check, so `run end` passed as the event name `runend` — a watcher armed on a name no journal will
# ever carry, which polls to its cap and reports "nothing happened". Caught by a control, not by use.
# **A cleanup that rescues a typo converts a loud exit into a silent never-match**, which is the exact
# failure this file exists to prevent, so whitespace is rejected rather than stripped.
case "$EVENTS" in
  *[!a-z0-9,-]*|''|*,,*|,*|*,)
    echo "watch-journal.sh: events must be a comma-separated list of [a-z0-9-] names with no spaces, got '$EVENTS'" >&2
    exit 64 ;;
esac
ALT=$(printf '%s' "$EVENTS" | tr ',' '|')
PAT="\"event\":\"($ALT)\""

newest_journal() {
  local d
  d=$(ls -t "$RUNS" 2>/dev/null | grep '^run-' | head -1)
  [ -n "$d" ] && [ -f "$RUNS/$d/journal.jsonl" ] && printf '%s' "$RUNS/$d/journal.jsonl"
}

# ── ARM-TIME SCOPING — the whole correctness argument, inherited from watch-parks.sh:57-64 ─────────────
# `run-end` is a HISTORICAL RECORD once written. A whole-file grep for it finds the PREVIOUS run's
# run-end on every resume, and on any re-arm after a run has ended — so the watcher exits in its first
# poll, a supervisor re-execs it into the same instant exit, and the process table shows coverage that
# does not exist. Only lines appended AFTER arming are evidence about now.
#
# Scoping by LINE POSITION rather than by an event COUNT also sidesteps the second trap that file
# documents: `grep -c` EXITS 1 WHEN THE COUNT IS ZERO while still printing `0`, so `n=$(grep -c P f ||
# echo 0)` yields the two-line string "0\n0" and every later `[ "$n" -gt … ]` dies with `integer
# expression expected` and evaluates FALSE — i.e. the armed-at-run-start watcher, the one case that
# matters, could never report its first event. This file never counts, so it cannot inherit that.
J=$(newest_journal)
base=0
[ -n "${J:-}" ] && base=$(wc -l < "$J" 2>/dev/null || echo 0)
seen_run="${J:-}"
since_arm() { tail -n +$((base + 1)) "$1" 2>/dev/null; }

field() { printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }
bucket() { printf '%s' "$2" | sed -n "s/.*\"$1\":\[\([^]]*\)\].*/\1/p" | head -1; }

report() {
  local line="$1" run="$2" ev
  ev=$(field event "$line")
  case "$ev" in
    run-end)
      local tv done failed human blocked pending verdict
      tv=$(field tipVerify "$line")
      done=$(bucket done "$line");     failed=$(bucket failed "$line")
      human=$(bucket human "$line");   blocked=$(bucket blocked "$line")
      pending=$(bucket pending "$line")
      # GREEN IS A CONJUNCTION, AND THE SHORT FORM OF IT IS WRONG. "run-end plus tip verify" passes a run
      # that ended `done=[T1,T3,T4] human=[T2]` — three delivered, one PARKED — and calling that green is
      # how a park becomes invisible. Grade every clause here so the reader never has to remember to.
      if [ "$tv" != "failed" ] && [ -z "$failed$human$blocked$pending" ]; then
        verdict="GREEN"
      else
        verdict="NOT GREEN"
      fi
      echo "RUN_END $run — $verdict (tipVerify=${tv:-unknown})"
      echo "  done=[${done}] failed=[${failed}] human=[${human}] blocked=[${blocked}] pending=[${pending}]"
      [ "$verdict" = "GREEN" ] \
        && echo "  all four buckets empty and tip verify is not failed — this run is green" \
        || echo "  a non-empty bucket above is the reason; name it, never report this run as green"
      ;;
    task-human)
      echo "TASK_HUMAN $(field taskId "$line") — $run"
      echo "  $(printf '%s' "$line" | sed -n 's/.*"reason":"\([^"]\{0,160\}\).*/\1/p')"
      echo "  a park waits for a DECISION; read the gate evidence, then \`tickmarkr approve $run $(field taskId "$line")\` or re-scope"
      ;;
    task-failed)
      echo "TASK_FAILED $(field taskId "$line") — $run"
      echo "  $(printf '%s' "$line" | sed -n 's/.*"error":"\([^"]\{0,160\}\).*/\1/p')"
      echo "  the run may continue on independent tasks; this task did not deliver"
      ;;
    consult-verdict)
      echo "CONSULT_VERDICT $(field taskId "$line") action=$(field action "$line") — $run"
      echo "  $(printf '%s' "$line" | sed -n 's/.*"notes":"\([^"]\{0,160\}\).*/\1/p')"
      ;;
    *)
      echo "JOURNAL_EVENT ${ev:-unparseable} — $run"
      echo "  ${line:0:200}"
      ;;
  esac
}

elapsed=0
while [ "$elapsed" -lt "$CAP" ]; do
  sleep "$POLL"
  elapsed=$((elapsed + POLL))

  J=$(newest_journal)
  [ -z "${J:-}" ] && continue

  # A new run resets the baseline — its whole journal is unseen by definition.
  if [ "$J" != "$seen_run" ]; then seen_run="$J"; base=0; fi

  hit=$(since_arm "$J" | grep -E "$PAT" | head -1)
  if [ -n "$hit" ]; then
    report "$hit" "$(basename "$(dirname "$J")")"
    exit 0
  fi
done

echo "WATCH_CAP_REACHED — no ${EVENTS} in ${CAP}s (newest: $(basename "$(dirname "${J:-none/none}")"))"
