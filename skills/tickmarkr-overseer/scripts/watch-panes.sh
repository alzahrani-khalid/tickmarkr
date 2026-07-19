#!/usr/bin/env bash
# watch-panes.sh — Herdr overseer watcher.
# Polls worker + orchestrator agent_status via `herdr pane get`, prints ONE wake
# reason to stdout, then exits. Run it via the Bash tool with run_in_background
# so the overseer is re-invoked when it fires. Re-run (re-arm) after every wake.
#
# Usage:
#   watch-panes.sh WORKER_PANE ORCH_PANE [--fast-blocked] [--cap-seconds N] [--settle-seconds N]
#
# Options:
#   --fast-blocked     Wake fast (20s debounce) whenever the WORKER blocks, even
#                      if the orchestrator is working. Use during stretches with
#                      human checkpoints. Without it, a blocked worker gets a 90s
#                      grace window for the orchestrator to handle it first
#                      (takeover rule), and only wakes if BOTH panes are quiet.
#   --cap-seconds N    Max watch duration (default 14400 = 4h).
#   --settle-seconds N Initial sleep before polling (default 60) so a
#                      just-dispatched turn can start without an instant refire.
#
# Wake reasons printed:
#   WORKER_PANE_GONE / ORCH_PANE_GONE   — a pane disappeared
#   ORCH:blocked WORKER:<s>             — orchestrator itself needs input
#   WORKER:blocked ORCH:<s>             — worker blocked (fast-blocked mode)
#   WORKER:<s> ORCH:<s>                 — both quiet: dropped handoff / done
#   WATCH_CAP_REACHED ...               — cap hit, everything still working
set -u
WORKER="${1:?worker pane id required}"
ORCH="${2:?orchestrator pane id required}"
shift 2
FAST_BLOCKED=false
CAP=14400
SETTLE=60
while [ $# -gt 0 ]; do
  case "$1" in
    --fast-blocked) FAST_BLOCKED=true ;;
    --cap-seconds) CAP="$2"; shift ;;
    --settle-seconds) SETTLE="$2"; shift ;;
  esac
  shift
done

get_status() {
  herdr pane get "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    p = d.get("result", {}).get("pane", d.get("result", {}))
    print(p.get("agent_status", "unknown"))
except Exception:
    print("gone")
' 2>/dev/null || echo gone
}

# Transient CLI/server failures also read as "gone" — recheck before declaring.
confirmed_gone() {
  sleep 5
  [ "$(get_status "$1")" = "gone" ]
}

END=$((SECONDS + CAP))
sleep "$SETTLE"
while [ $SECONDS -lt $END ]; do
  WS=$(get_status "$WORKER")
  OS=$(get_status "$ORCH")
  if [ "$WS" = "gone" ]; then
    confirmed_gone "$WORKER" && { echo "WORKER_PANE_GONE ORCH:$(get_status "$ORCH")"; exit 0; }
    continue
  fi
  if [ "$OS" = "gone" ]; then
    confirmed_gone "$ORCH" && { echo "ORCH_PANE_GONE WORKER:$(get_status "$WORKER")"; exit 0; }
    continue
  fi
  # orchestrator itself stuck on a prompt (debounced)
  if [ "$OS" = "blocked" ]; then
    sleep 15
    [ "$(get_status "$ORCH")" = "blocked" ] && { echo "ORCH:blocked WORKER:$WS"; exit 0; }
  fi
  # human-checkpoint mode: wake fast on any persisting worker block
  if $FAST_BLOCKED && [ "$WS" = "blocked" ]; then
    sleep 20
    [ "$(get_status "$WORKER")" = "blocked" ] && { echo "WORKER:blocked ORCH:$(get_status "$ORCH")"; exit 0; }
  fi
  # standard mode: worker needs attention AND orchestrator is not driving
  if [ "$WS" != "working" ]; then
    sleep 90
    WS2=$(get_status "$WORKER"); OS2=$(get_status "$ORCH")
    if [ "$WS2" != "working" ] && [ "$OS2" != "working" ]; then
      echo "WORKER:$WS2 ORCH:$OS2"; exit 0
    fi
  fi
  sleep 20
done
echo "WATCH_CAP_REACHED WORKER:$(get_status "$WORKER") ORCH:$(get_status "$ORCH")"
