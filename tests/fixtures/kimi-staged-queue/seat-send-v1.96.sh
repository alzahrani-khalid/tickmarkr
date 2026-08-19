#!/bin/bash
# Deliver ONE directive to a seat with VERIFIED submission — the send path that failed five distinct
# ways in one leg (2026-08-17, P98): front-truncation at the PTY (~1024B), text sitting unsubmitted,
# two silent losses, and probes that mistook presence for delivery. A prose protocol loses one step
# under load; this encodes the steps.
#
#   seat-send.sh <agent-name-or-pane> <message>
#
#   TKR_INTERRUPT=1  end a `working` seat's turn first (Esc, at most twice, verified between) so the
#                    directive is READ now instead of queued behind the turn. A message to a working
#                    claude seat lands in its queue and drains only at the turn boundary — with
#                    in-process teammates that is 20–40 minutes, so A QUEUED HOLD IS NOT A HOLD.
#                    Measured 2026-08-18: two freeze-class directives sat queued behind a planner's
#                    teammate fan-out and THE OPERATOR pressed Esc by hand because no seat owned the
#                    interrupt. The interrupt loses the seat's in-flight step; for a correctness-class
#                    directive that is the price, and it is cheaper than a voided verdict.
#
# ⚠ WHY THE READ-BACK IS THE PROMPT LINE AND NOTHING ELSE (measured 2026-08-18, three methods failing
# identically): `herdr pane read` INCLUDES THE INPUT BOX, so an unsubmitted message renders exactly
# like a submitted one and every content-based probe — token grep, tail token, full-text match —
# returns the same answer in both states. A freeze hold was "verified delivered" three ways and had
# never been submitted; the receiving seat stopped 19 minutes later without ever reading it. Only the
# PROMPT LINE discriminates: text sitting on `❯` is exactly what will not run. Prompt-line state
# alone, or nothing — a decorative check beside a real one reads as corroboration.
#
# First output line is the machine-greppable verdict:
#   DELIVERED_SUBMITTED | QUEUED_BEHIND_TURN | SEND_UNSUBMITTED | INTERRUPT_FAILED | TARGET_GONE
#   | REFUSED_SIZE | REFUSED_BOX_OCCUPIED
#
# This verifies SUBMISSION — the text left the input box — never that the seat understood or acted.
# Read the seat's ARTIFACT for that; a send receipt is not a response.
set -u

TARGET="${1:?usage: seat-send.sh <agent-name-or-pane> <message>}"
MSG="${2:?message required}"

# PTY input front-truncates around 1KB and a truncated brief silently drops policy — the drop is at
# the FRONT, so what survives still reads as a complete message. Long content goes in a FILE; the
# pane gets one line pointing at it.
if [ "${#MSG}" -gt 900 ]; then
  echo "REFUSED_SIZE ${#MSG} bytes — write a brief file and send a one-line pointer instead"; exit 2
fi

status_of() {
  herdr agent get "$TARGET" 2>/dev/null \
    | sed -n 's/.*"agent_status":"\([a-z_]*\)".*/\1/p' | head -1
}

# The rendered `❯` line — the only state that discriminates submitted from sitting. head -1 returns
# the first rendered line, i.e. a PREFIX of a wrapped draft, so callers compare prefixes, never
# whole sentences (OBS-396: a full-sentence match returns false on a message that arrived intact).
prompt_line() {
  herdr agent read "$TARGET" --source visible --lines 14 2>/dev/null \
    | sed -n 's/^[[:space:]]*❯[[:space:]]*//p' | head -1 | sed 's/[[:space:]]*$//'
}

# Is $1 a rendered prefix of our message? (first line of a wrapped draft = prefix of MSG)
is_ours() {
  case "$MSG" in "$1"*) return 0 ;; *) return 1 ;; esac
}

# GHOST DISCRIMINATOR (OBS-482): claude-code AUTOSUGGEST renders its suggestion on the prompt line
# wrapped in SGR dim; typed text renders default. A dim-wrapped line is rendering, not state.
is_ghost() {
  herdr agent read "$TARGET" --source visible --lines 14 --format ansi 2>/dev/null \
    | grep -F -- "❯" | grep -F -- "$1" | head -1 | grep -q "$(printf '\033')\[2m"
}

S=$(status_of)
if [ -z "$S" ]; then
  echo "TARGET_GONE $TARGET — agent get returned nothing (pane closed, or the name resolves nowhere)"
  exit 1
fi

# A pre-existing draft in the box is a decision, not an obstacle: `agent prompt` would APPEND to it
# and submit both. Superseding someone else's text needs an author and the arrow form — refuse and
# surface it rather than silently stomping it (D-206: an unattributed line in a box, origin never
# resolved because it was cleared).
PRE=$(prompt_line)
if [ -n "$PRE" ] && ! is_ghost "$PRE"; then
  echo "REFUSED_BOX_OCCUPIED $TARGET — input box already holds: $PRE"
  echo "  ANSI-verify first (dim SGR = autosuggest ghost, ignorable). A real draft is superseded by a"
  echo "  DECISION, not by this script: send the arrow form naming what you are overriding."
  exit 2
fi

QUEUED=""
if [ "$S" = "working" ]; then
  if [ "${TKR_INTERRUPT:-0}" = "1" ]; then
    # Esc at most twice, VERIFIED between: the first Esc can merely dismiss a UI surface or stop one
    # step (the operator needed two on 2026-08-18). Unbounded Esc into an idle seat starts clearing
    # state that is not yours to clear.
    for _ in 1 2; do
      herdr agent send-keys "$TARGET" esc >/dev/null 2>&1
      sleep 3
      S=$(status_of)
      [ "$S" != "working" ] && break
    done
    if [ "$S" = "working" ]; then
      echo "INTERRUPT_FAILED $TARGET still working after 2x esc — NOT sending; a directive queued now lands after the turn, which is the failure you set TKR_INTERRUPT to avoid"
      exit 1
    fi
  else
    QUEUED=1
  fi
fi

# Atomic text+Enter honouring the pane's live bracketed-paste mode — never send-text + separate
# Enter, which is the "sitting unsubmitted" failure by construction.
herdr agent prompt "$TARGET" "$MSG" >/dev/null 2>&1

sleep 2
PL=$(prompt_line)
if [ -n "$PL" ] && is_ours "$PL"; then
  # The text is SITTING, not sent — the swallowed-Enter shape. Submitting the existing draft is not a
  # re-send (nothing is duplicated); one bounded Enter, then re-read.
  herdr agent send-keys "$TARGET" enter >/dev/null 2>&1
  sleep 2
  PL=$(prompt_line)
fi

if [ -n "$PL" ] && is_ours "$PL"; then
  echo "SEND_UNSUBMITTED $TARGET — the message is SITTING on the prompt line after send + one Enter."
  echo "  Do NOT re-send (it appends and submits both). Read the pane; supersede with the arrow form."
  exit 1
fi

if [ -n "$PL" ]; then
  # Not ours: either autosuggest ghost (dim SGR — benign) or a draft that appeared under us.
  echo "DELIVERED_SUBMITTED $TARGET — prompt line clear of our text; NOTE it now holds: $PL"
  echo "  ANSI-verify (dim = ghost). If typed, treat per D-206: discriminate before anyone clears it."
  exit 0
fi

if [ -n "$QUEUED" ]; then
  echo "QUEUED_BEHIND_TURN $TARGET — submitted into a working seat's queue; it is READ at turn end. A freeze-class or superseding directive belongs behind TKR_INTERRUPT=1."
else
  echo "DELIVERED_SUBMITTED $TARGET"
fi
exit 0
