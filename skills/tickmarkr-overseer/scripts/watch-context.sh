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
# usage: watch-context.sh <agent|pane> <warn-pct> <act-pct> [handoff-file] [poll-s] [cap-s]
#   TKR_AUTO_CLEAR=1   at act-pct WITH a fresh handoff, send /clear and re-brief instead of waking.
#   TKR_REBRIEF=<path> the file the re-briefed seat is told to read (defaults to the handoff).
#   TKR_HANDOFF_MAX_AGE_S  how fresh "fresh" is (default 900).

set -u
TARGET="${1:?agent name or pane id required}"
WARN="${2:-60}"
ACT="${3:-75}"
HANDOFF="${4:-}"
POLL="${5:-120}"
CAP="${6:-28800}"
MAXAGE="${TKR_HANDOFF_MAX_AGE_S:-900}"
REBRIEF="${TKR_REBRIEF:-$HANDOFF}"

# The seat's own rendered truth. Anchor on the model marker so a percentage elsewhere on screen — a
# progress figure, a coverage number — cannot be mistaken for the context gauge.
context_pct() {
  herdr agent read "$TARGET" --source visible --lines 8 2>/dev/null \
    | grep '✳' | tail -1 | grep -oE '[0-9]+%' | tail -1 | tr -d '%'
}

handoff_fresh() {
  [ -n "$HANDOFF" ] || return 1
  [ -f "$HANDOFF" ] || return 1
  local age now mt
  now=$(date +%s)
  mt=$(stat -f %m "$HANDOFF" 2>/dev/null || stat -c %Y "$HANDOFF" 2>/dev/null) || return 1
  age=$((now - mt))
  [ "$age" -le "$MAXAGE" ]
}

warned=0
elapsed=0
while [ "$elapsed" -lt "$CAP" ]; do
  P=$(context_pct)
  if [ -z "$P" ]; then
    sleep "$POLL"; elapsed=$((elapsed + POLL)); continue
  fi

  if [ "$P" -ge "$ACT" ] 2>/dev/null; then
    if handoff_fresh; then
      if [ "${TKR_AUTO_CLEAR:-0}" = "1" ]; then
        herdr agent prompt "$TARGET" "/clear" >/dev/null 2>&1
        sleep 6
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
  fi

  if [ "$P" -ge "$WARN" ] 2>/dev/null && [ "$warned" -eq 0 ]; then
    warned=1
    echo "CONTEXT_WARN $TARGET ${P}% (>= ${WARN}) — write the handoff NOW, while judgement is still good"
    echo "  a handoff written at ${ACT}% is written by a seat already degraded; that is the wrong time"
    exit 0
  fi

  sleep "$POLL"; elapsed=$((elapsed + POLL))
done

echo "WATCH_CAP_REACHED $TARGET context=$(context_pct)% — no threshold crossed in ${CAP}s"
