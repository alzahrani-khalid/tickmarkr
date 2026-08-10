#!/bin/bash
# watch-contamination.sh — wake the AUTHORITY seat when a gate VERDICT may be contaminated.
#
# Operator, 2026-08-07: "that is the kind of job I need overseer to be vigilant about."
#
# Why this belongs to the authority tier and not the orchestrator: deciding gates is this seat's
# column, and a gate verdict produced under machine starvation is not a verdict. Verifying the
# CONDITIONS under which evidence was produced is therefore part of ruling on it, not run-driving.
#
# It wakes on the two things that make a red gate untrustworthy:
#   1. a NEW failed gate-result whose details carry an infrastructure fingerprint (OBS-426)
#   2. sustained load high enough that any suite result is suspect
#
# Prints ONE wake reason and exits, so its exit re-invokes the session. Re-arm after every wake.
#
# usage: watch-contamination.sh <journal> <load-ceiling> <poll-s> <cap-s>

set -u
J="${1:?journal path required}"
LOAD_CEIL="${2:-24}"
POLL="${3:-45}"
CAP="${4:-14400}"

STATE="$(dirname "$J")/.contamination.seen"
: > "$STATE" 2>/dev/null || STATE="/tmp/.contamination.seen.$$"

# Fingerprints of a harness collapse rather than a real regression. Deliberately narrow: a genuine
# assertion failure must NOT match, or the watcher launders real defects into "infra".
INFRA_RE='vitest-worker|Timeout calling|JS heap out of memory|ENOMEM|EAGAIN|spawn ENOENT|Killed|SIGKILL'

load1() { uptime | sed 's/.*load averages*: *//' | awk '{print $1}' | tr -d ','; }
vitest_n() { pgrep -f vitest 2>/dev/null | wc -l | tr -d ' '; }

# Seed the seen-set so we wake on what happens NEXT, not on history already ruled on.
if [ -f "$J" ]; then
  grep -c '' "$J" > "$STATE" 2>/dev/null || echo 0 > "$STATE"
else
  echo 0 > "$STATE"
fi

elapsed=0
while [ "$elapsed" -lt "$CAP" ]; do
  sleep "$POLL"
  elapsed=$((elapsed + POLL))

  L=$(load1); V=$(vitest_n)
  Li=${L%%.*}; [ -z "$Li" ] && Li=0

  if [ -f "$J" ]; then
    seen=$(cat "$STATE" 2>/dev/null); [ -z "$seen" ] && seen=0
    now=$(grep -c '' "$J" 2>/dev/null); [ -z "$now" ] && now=0
    if [ "$now" -gt "$seen" ]; then
      newrows=$(tail -n "$((now - seen))" "$J" 2>/dev/null)
      echo "$now" > "$STATE"
      hit=$(printf '%s\n' "$newrows" \
        | grep '"event":"gate-result"' \
        | grep '"pass":false' \
        | grep -E "$INFRA_RE" | head -1)
      if [ -n "$hit" ]; then
        task=$(printf '%s' "$hit" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
        gate=$(printf '%s' "$hit" | sed -n 's/.*"gate":"\([^"]*\)".*/\1/p')
        echo "CONTAMINATED_VERDICT task=$task gate=$gate load=$L vitest=$V"
        echo "  an infra fingerprint appeared in a FAILED gate — this red is not evidence about the diff"
        echo "  ruling owed: is the attempt chargeable? (OBS-426: infra failures are not)"
        exit 0
      fi
    fi
  fi

  if [ "$Li" -ge "$LOAD_CEIL" ] 2>/dev/null; then
    echo "LOAD_CEILING load=$L (ceiling $LOAD_CEIL) vitest=$V"
    echo "  any suite result produced now is suspect; a red test gate may be starvation, not a regression"
    exit 0
  fi
done

echo "WATCH_CAP_REACHED load=$(load1) vitest=$(vitest_n) — no contaminated verdict seen in ${CAP}s"
