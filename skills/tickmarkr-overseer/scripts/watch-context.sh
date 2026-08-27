#!/bin/bash
# watch-context.sh — wake (or act) when a seat's CONTEXT is running out, and only clear when it is SAFE.
#
# Context is the one resource a seat cannot observe about itself reliably and cannot recover from once
# spent. This project's law is `/clear` plus a fresh brief, NEVER `/compact` — a compaction is a lossy
# summary nobody trusts, while a clean session re-oriented from disk-verifiable state is reliable.
#
# The measurement everyone misses: a seat's context percentage is RENDERED IN ITS OWN STATUSLINE. It does
# not need to be asked, and asking is unreliable — a seat estimating its own usage is guessing.
#
# WHAT MAKES A CLEAR SAFE, and this is the whole point of the script:
#   A clear is safe exactly when NOTHING THE SEAT IS HOLDING EXISTS ONLY IN ITS HEAD.
# Operationally: a handoff artifact exists AND is newer than the seat's last significant action. If the
# handoff is stale, the seat is holding state that a clear would destroy, and the correct move is to wake
# a supervisor — never to clear and hope.
#
# THIS WATCHER IS SUPERVISED, and the tier is PER SEAT: `<role>-context`, one per supervising seat, so a
# live overseer watcher can never make a dead orchestrator one read as covered. Every beat declares the
# seat it watches (`--seat`), because a tier that is armed and seatless reads as coverage, which is worse
# than absent. Four rules the shipped version broke, each of which made the tier lie:
#   1. BEAT ON THE SUPERVISION CADENCE, NOT ON THE POLL. Beats gap by TICK (below), never by POLL, so a
#      poll interval above the supervision beat interval cannot leave the tier stale half of every cycle.
#   2. BEAT ONLY AFTER A SUCCESSFUL READ. A watcher that cannot see its seat's percentage is not
#      watching it; beating anyway reports coverage it is not providing, and the tier must age out.
#   3. WARN DOES NOT EXIT. Warn precedes act, so exiting at warn meant the act was never reached and the
#      last beat aged into a permanent stale — gradual growth never reached the auto-clear path at all.
#   4. EVERY TERMINAL EXIT STANDS THE TIER DOWN, so a watcher that finished reads DISARMED, not dead.
#      Only a killed watcher reads STALE, which is exactly what STALE means.
#
# usage: watch-context.sh <orchestrator|overseer> <agent|pane> <warn-pct> <act-pct> [handoff-file] [poll-s] [cap-s]
#   TKR_AUTO_CLEAR=1   at act-pct WITH a fresh handoff, send /clear and re-brief instead of waking.
#   TKR_REBRIEF=<path> the file the re-briefed seat is told to read (defaults to the handoff).
#   TKR_HANDOFF_MAX_AGE_S  how fresh "fresh" is (default 900).
#   TKR_CLEAR_SETTLE_S     seconds to let a cleared seat settle before the re-brief (default 6).

set -u
ROLE="${1:?supervising seat role required: orchestrator|overseer}"
TARGET="${2:?agent name or pane id required}"
WARN="${3:-60}"
ACT="${4:-75}"
HANDOFF="${5:-}"
POLL="${6:-120}"
CAP="${7:-28800}"
MAXAGE="${TKR_HANDOFF_MAX_AGE_S:-900}"
REBRIEF="${TKR_REBRIEF:-$HANDOFF}"
SETTLE="${TKR_CLEAR_SETTLE_S:-6}"

case "$ROLE" in
  orchestrator|overseer) TIER="${ROLE}-context" ;;
  *) echo "watch-context.sh: unknown seat role '$ROLE' — expected orchestrator or overseer" >&2; exit 64 ;;
esac

# The supervision beat interval (SUPERVISION_BEAT_MS = 10s). The loop ticks at the beat cadence or the
# caller's poll, whichever is SHORTER: a beat may only follow a successful read (rule 2), so the read
# cadence is the floor on the beat cadence, and the tier's freshness is never the caller's to widen.
BEAT_EVERY=5
TICK=$(( POLL < BEAT_EVERY ? POLL : BEAT_EVERY ))
[ "$TICK" -ge 1 ] 2>/dev/null || TICK=1   # a zero or junk poll would spin, not watch
SEAT="$TARGET"

beat()      { tickmarkr beat "$TIER" --seat "$SEAT" >/dev/null 2>&1; }
stand_down() { tickmarkr beat "$TIER" --stand-down --seat "$SEAT" >/dev/null 2>&1; }
# EVERY terminal exit — act, unsafe-act, cap — leaves through here, so none of them can forget to
# record the hand-off. A killed watcher never runs it, which is the one case that must read STALE.
trap stand_down EXIT

# The seat's own rendered truth. Prefer a line carrying a context marker so a percentage elsewhere on
# screen cannot be mistaken for the gauge — but NEVER require one: the ✳ marker the shipped version
# anchored on is rendered by a single vendor, so every other seat read empty, beat anyway and slept to
# its cap while its tier claimed coverage. The last percentage in the statusline window is the fallback.
context_pct() {
  local screen marked
  screen=$(herdr agent read "$TARGET" --source visible --lines 8 2>/dev/null) || return 1
  marked=$(printf '%s\n' "$screen" | grep -iE '✳|context' | grep -oE '[0-9]+%' | tail -1 | tr -d '%')
  [ -n "$marked" ] && { printf '%s\n' "$marked"; return 0; }
  printf '%s\n' "$screen" | grep -oE '[0-9]+%' | tail -1 | tr -d '%'
}

handoff_fresh() {
  [ -n "$HANDOFF" ] || return 1
  [ -f "$HANDOFF" ] || return 1
  local age now mt
  now=$(date +%s)
  mt=$(stat -c %Y "$HANDOFF" 2>/dev/null || stat -f %m "$HANDOFF" 2>/dev/null) || return 1
  age=$((now - mt))
  [ "$age" -le "$MAXAGE" ]
}

act_on() {
  local P="$1"
  if handoff_fresh; then
    if [ "${TKR_AUTO_CLEAR:-0}" = "1" ]; then
      herdr agent prompt "$TARGET" "/clear" >/dev/null 2>&1
      sleep "$SETTLE"
      herdr agent prompt "$TARGET" "Read ${REBRIEF} and continue exactly where it says. Your context was cleared at ${P}% against that handoff; it is current as of $(date '+%H:%M'). Do not reconstruct from memory — everything you need is on disk." >/dev/null 2>&1
      echo "CONTEXT_CLEARED $TARGET at ${P}% — handoff fresh, re-briefed from ${REBRIEF}"
      exit 0
    fi
    echo "CONTEXT_ACT $TARGET ${P}% (>= ${ACT}) — handoff is FRESH, a clear is SAFE now"
    echo "  herdr agent prompt $TARGET \"/clear\"  then re-brief from ${REBRIEF}"
    exit 0
  fi
  echo "CONTEXT_ACT_UNSAFE $TARGET ${P}% (>= ${ACT}) — NO FRESH HANDOFF (${HANDOFF:-none})"
  echo "  the seat is holding state that exists only in its head; a clear would destroy it"
  echo "  make it write the handoff FIRST, then clear"
  exit 0
}

warned=0
elapsed=0
while [ "$elapsed" -lt "$CAP" ]; do
  P=$(context_pct)
  if [ -z "$P" ]; then
    # Rule 2: no reading, no beat. The tier ages to STALE and a supervisor comes looking, which is the
    # truth about a watcher that cannot see the seat it was armed on.
    sleep "$TICK"; elapsed=$((elapsed + TICK)); continue
  fi
  beat

  if [ "$P" -ge "$ACT" ] 2>/dev/null; then
    act_on "$P"
  fi

  if [ "$P" -ge "$WARN" ] 2>/dev/null && [ "$warned" -eq 0 ]; then
    # Rule 3: warn is a LINE, not an exit — the act is on the far side of it.
    warned=1
    echo "CONTEXT_WARN $TARGET ${P}% (>= ${WARN}) — write the handoff NOW, while judgement is still good"
    echo "  re-brief target when it acts: ${REBRIEF:-none}"
    echo "  a handoff written at ${ACT}% is written by a seat already degraded; that is the wrong time"
  fi

  sleep "$TICK"; elapsed=$((elapsed + TICK))
done

echo "WATCH_CAP_REACHED $TARGET context=$(context_pct)% — no threshold crossed in ${CAP}s"
