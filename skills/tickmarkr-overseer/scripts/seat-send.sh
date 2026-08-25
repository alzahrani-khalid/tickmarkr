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
#   | REFUSED_SIZE | REFUSED_BOX_OCCUPIED | SEND_UNVERIFIED | SEND_REFUSED | SEND_FAILED
#
# A success verdict names the surface that delivered when it was not the default one, so a fallback
# is visible in the transcript rather than inferred (OBS-552).
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

# The submit-fallback needs a PANE id, and $TARGET may be an agent NAME. `agent get` answers for a
# detected-but-undrivable seat — it is only `agent prompt` that refuses one (OBS-552) — so this
# resolves either target form. The first `pane_id` in the response is the agent's own.
pane_of() {
  herdr agent get "$TARGET" 2>/dev/null \
    | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1
}

# The rendered `❯` line — the only state that discriminates submitted from sitting. tail -1 takes
# the LAST `❯` line, which is always the LIVE INPUT BOX: a wrapped draft's continuation lines carry
# no `❯`, so the last one is still that draft's FIRST rendered line, i.e. a PREFIX of the draft —
# callers compare prefixes, never whole sentences (OBS-396: a full-sentence match returns false on a
# message that arrived intact).
#
# SUBMITTED-ECHO DISCRIMINATOR (OBS-603, captured 2026-08-25 on an overseer's first send). claude-code
# echoes a SUBMITTED message into the transcript with the same `❯` glyph, and a long one still occupies
# this 14-line window ABOVE the empty box. The old `head -1` returned that echo, `is_ours` matched it
# (the echo IS a prefix of $MSG), and one delivered message drew TWO false verdicts: SEND_UNSUBMITTED on
# the send that made the echo, then REFUSED_BOX_OCCUPIED on the NEXT send — the worse half, because it
# refuses to deliver at all and leaves the seat unreachable until the echo scrolls out. Both reactions
# this script warns against are then wrong: re-sending appends and submits both, escalating reports a
# failure that never happened. OBS-396's phantom, one layer up.
#
# ⚠ POSITION IS NOT THE DISCRIMINATOR, and the kimi control below proves it: the two TUIs render in
# OPPOSITE order. kimi puts the live box FIRST and stages BELOW it; claude-code puts the echo FIRST and
# the live box BELOW. So `head -1` is wrong for one and `tail -1` is wrong for the other — a fix that
# only flipped them would have traded this defect for the staged-queue defect OBS-552 already paid for.
# What actually identifies the ordinary input box is that it is the LAST `❯` line which is NOT a staged
# entry: staged lines carry the `↑ to edit · ctrl-s to steer` affordance and belong to `staged_line()`,
# which owns that concept. Dropping them here makes this function's contract exact — the live ORDINARY
# box — instead of positional, and it reads the affordance rather than a vendor name, so any TUI that
# grows the same queue is covered without a matcher list.
prompt_line() {
  herdr agent read "$TARGET" --source visible --lines 14 2>/dev/null \
    | sed '/↑ to edit/{/steer/d;}' \
    | sed -n 's/^[[:space:]]*❯[[:space:]]*//p' | tail -1 | sed 's/[[:space:]]*$//'
}

# STAGED-QUEUE DISCRIMINATOR (OBS-552 addendum, captured 2026-08-19 on a live kimi seat). After its
# first turn ends, kimi stages every later message into a SECOND `❯` region —
# `❯ <text> ↑ to edit · ctrl-s to steer immediately` — and EMPTIES the ordinary box when it does. So
# `prompt_line`'s emptiness is not submission on a kimi seat: it is the queue swallowing the
# directive. Six consecutive paths were tried against that state and the pane revision never moved
# off 3; `seat-send.sh` called the first one DELIVERED_SUBMITTED. This reads the staging AFFORDANCE
# rather than the vendor name, so any TUI that grows the same queue is covered without a matcher list.
# Returns the staged TEXT only: the `❯` marker and the trailing affordance are chrome, and leaving the
# affordance on would break `is_ours`, whose contract is that the rendered text is a PREFIX of $MSG
# (OBS-396). A wrapped staged entry still yields a prefix, which is all the comparison needs.
staged_line() {
  herdr agent read "$TARGET" --source visible --lines 14 2>/dev/null \
    | sed -n '/↑ to edit/{/steer/p;}' | head -1 \
    | sed 's/^[[:space:]]*❯[[:space:]]*//' \
    | sed 's/[[:space:]]*↑ to edit.*$//' \
    | sed 's/[[:space:]]*$//'
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
#
# OBS-552: the outcome of this verb was thrown away — `>/dev/null 2>&1` discarded BOTH the exit code
# and the reason. A refusal that wrote NOTHING then fell through to the prompt-line checks below with
# an empty line, which is byte-identical to a clean submit, and this script exited 0 announcing
# DELIVERED_SUBMITTED — or QUEUED_BEHIND_TURN when the seat read `working`, which also EXPLAINS AWAY
# the silence that follows. Measured 2026-08-19 against a live seat: `herdr agent prompt` refuses a
# detected-but-undrivable occupant with `agent_not_ready` and never touches the input box, while
# `pane run` delivers to that same pane. A send receipt that cannot fail is not a receipt.
PROMPT_ERR=$(herdr agent prompt "$TARGET" "$MSG" 2>&1 >/dev/null)
PROMPT_RC=$?
VIA=""
if [ "$PROMPT_RC" -ne 0 ]; then
  case "$PROMPT_ERR" in
    *agent_not_ready*)
      # UNEQUIVOCALLY PRE-WRITE: herdr rejected the target before typing anything, so a second
      # delivery cannot duplicate. This is the ONLY class that earns a fallback.
      PANE=$(pane_of)
      if [ -z "$PANE" ]; then
        echo "SEND_REFUSED $TARGET — agent prompt refused pre-write and no pane id resolved: $PROMPT_ERR"
        exit 1
      fi
      PANE_ERR=$(herdr pane run "$PANE" "$MSG" 2>&1 >/dev/null)
      PANE_RC=$?
      if [ "$PANE_RC" -ne 0 ]; then
        echo "SEND_FAILED $TARGET — both delivery surfaces refused; nothing was typed."
        echo "  agent prompt: $PROMPT_ERR"
        echo "  pane run ($PANE): $PANE_ERR"
        exit 1
      fi
      VIA=" (via pane run $PANE — agent prompt refused pre-write: $PROMPT_ERR)"
      ;;
    *)
      # AMBIGUOUS: this class cannot prove the write did not land, and a second delivery APPENDS to
      # whatever did. So it never retries — it surfaces the cause and stops, which is the one outcome
      # the discarded stderr made impossible.
      echo "SEND_UNVERIFIED $TARGET — agent prompt exited $PROMPT_RC with an ambiguous outcome: $PROMPT_ERR"
      echo "  NOT retrying (a second send appends to anything that landed). Read the pane, then decide."
      exit 1
      ;;
  esac
fi

sleep 2

# BEFORE any emptiness verdict: a non-empty staged queue means this seat has accepted text and is not
# running it, so an empty ordinary box proves nothing. Fail closed — there is no delivery remedy to
# offer, and every one was tried against the captured instance: bare `enter` on the empty box no-ops,
# `up`+`enter` moves the entry to the box and puts it straight BACK in the queue, `herdr agent
# send-keys` cannot type kimi's own `ctrl-s` affordance (no ctrl chords), and `pane run` is a
# shell-pane path with no effect on a TUI. Recovery is the operator's: capture provenance
# (pid/ppid/pgid/lstart), TERM the CLI, then `herdr agent start … -- --auto -c` in the SAME pane —
# session continuation preserved 136k of context and the queue drained on restart. NEVER retry here:
# the entry may drain at any moment and a second send would then run twice.
STAGED=$(staged_line)
if [ -n "$STAGED" ]; then
  if is_ours "$STAGED"; then
    echo "SEND_UNVERIFIED $TARGET — the directive is STAGED in the seat's queue, not running: $STAGED"
  else
    echo "SEND_UNVERIFIED $TARGET — this seat's queue holds an entry that is not draining, so nothing sent now is running: $STAGED"
  fi
  echo "  An empty prompt line does NOT mean submitted on a staging TUI — the box is empty BECAUSE the"
  echo "  text went to the queue. Do NOT re-send: the queue may drain at any moment and run it twice."
  echo "  No input path drains it (enter no-ops, up+enter re-queues, send-keys has no ctrl chords,"
  echo "  pane run is shell-only). Capture provenance, TERM the CLI, restart it in the SAME pane with"
  echo "  session continuation, then verify the pane REVISION moves before trusting any receipt."
  exit 1
fi
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
  echo "DELIVERED_SUBMITTED $TARGET$VIA — prompt line clear of our text; NOTE it now holds: $PL"
  echo "  ANSI-verify (dim = ghost). If typed, treat per D-206: discriminate before anyone clears it."
  exit 0
fi

if [ -n "$QUEUED" ]; then
  echo "QUEUED_BEHIND_TURN $TARGET$VIA — submitted into a working seat's queue; it is READ at turn end. A freeze-class or superseding directive belongs behind TKR_INTERRUPT=1."
else
  echo "DELIVERED_SUBMITTED $TARGET$VIA"
fi
exit 0
