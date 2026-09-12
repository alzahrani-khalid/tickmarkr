#!/usr/bin/env bash
# watch-launch.sh — a GO that produced no run is a silent failure until someone notices. This watcher
# notices. Arm it in the SAME act as the GO (orchestrator briefed to compile → plan → run) and it waits
# for the run's lock; when the lock has not appeared by the deadline it delivers LAUNCH OVERDUE to the
# overseer's pane AND as an OS notification, so the wake reaches a seat instead of a log nobody reads.
#
# Why it exists (2026-09-11): an orchestrator's codex sandbox was rooted at the main repo, the spec
# worktree was outside its writable roots, it stopped at the denial without reporting, and the overseer's
# own 10-minute wake expired un-re-armed. Three hours passed before anyone looked. A launch has a
# deadline; silence past it is the event.
#
# usage: watch-launch.sh <lock-path> <deadline-s> <overseer-pane> [poll-s]
#   <lock-path>      the run's .tickmarkr/graph.lock in the worktree the run will be launched in
#   <deadline-s>     seconds from now by which the lock must exist (a compile+plan+launch takes minutes,
#                    never hours; 900 is a generous default for a 7-task spec)
#   <overseer-pane>  the pane that must hear about it (herdr pane id), e.g. wZ:p18S
#   [poll-s]         poll interval, default 15
# exit 0 LAUNCH_OK (lock seen; prints its contents) · exit 3 LAUNCH_OVERDUE (delivered) · exit 64 usage
set -u
LOCK="${1:-}"; DEADLINE="${2:-}"; PANE="${3:-}"; POLL="${4:-15}"
[ -n "$LOCK" ] && [ -n "$DEADLINE" ] && [ -n "$PANE" ] || { echo "usage: watch-launch.sh <lock-path> <deadline-s> <overseer-pane> [poll-s]" >&2; exit 64; }
start=$(date +%s)
while :; do
  if [ -f "$LOCK" ]; then
    printf 'LAUNCH_OK %s %s\n' "$(date -u +%H:%M:%SZ)" "$(cat "$LOCK" 2>/dev/null | tr -d '\n')"
    exit 0
  fi
  now=$(date +%s)
  if [ $((now - start)) -ge "$DEADLINE" ]; then
    msg="LAUNCH OVERDUE $(date -u +%H:%M:%SZ): no lock at $LOCK after ${DEADLINE}s — read the orchestrator pane NOW (sandbox denial? preflight refusal? unsubmitted GO?)"
    echo "LAUNCH_OVERDUE $msg"
    # Both deliveries, always: a pane the overseer reads AND a notification the operator sees.
    herdr pane run "$PANE" "$msg" >/dev/null 2>&1 || echo "  (pane delivery failed — the notification is the only path)"
    herdr notification show "$msg" >/dev/null 2>&1 || true
    exit 3
  fi
  sleep "$POLL"
done
