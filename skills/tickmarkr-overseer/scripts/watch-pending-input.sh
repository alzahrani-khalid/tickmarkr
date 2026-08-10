#!/bin/bash
# watch-pending-input.sh — wake when a seat is IDLE with UNSUBMITTED TEXT in its input box.
#
# The third quiet state, and the two standard watchers are both blind to it:
#   blocked-state  (`herdr agent wait --until blocked`)  — the seat is NOT blocked, it is idle
#   artifact       (`watch-artifacts.sh`)                — no file appears, and none ever will
# A seat in this state reports `done`, holds live work in its own prompt, and does nothing forever.
#
# Measured 2026-08-07, twice in one hour on one orchestrator: `❯ classify worker-dead-held, then author
# the fresh-run spec` and `❯ dry-compile ships too — add it as T13`, each sitting unsubmitted while the
# seat read `done`. Both were found only because a supervising seat happened to read the pane. An Enter
# swallowed by bracketed paste produces exactly this, and so does a draft the seat never sent.
#
# Prints ONE wake reason and exits. Re-arm after every wake.
#
# usage: watch-pending-input.sh <agent-name-or-pane> [poll-s] [cap-s] [confirm-polls]

set -u
TARGET="${1:?agent name or pane id required}"
POLL="${2:-30}"
CAP="${3:-14400}"
CONFIRM="${4:-2}"        # consecutive polls before waking — a draft mid-typing is not a stall

status_of() {
  herdr agent get "$TARGET" 2>/dev/null \
    | sed -n 's/.*"agent_status":"\([a-z_]*\)".*/\1/p' | head -1
}

# The rendered prompt line is the condition itself. `agent_status` is the harness's OPINION about the
# seat and fails in both directions (a wedged worker has reported `idle`, a working one `done`), so the
# text in the box is the stronger signal — it is what will not run.
pending_text() {
  herdr agent read "$TARGET" --source visible --lines 14 2>/dev/null \
    | sed -n 's/^[[:space:]]*❯[[:space:]]*//p' | head -1 \
    | sed 's/[[:space:]]*$//'
}

# Auto-supersede is OPT-IN and BUDGETED. It resubmits the seat's own draft and keeps watching instead of
# waking anyone. The budget exists because a seat stalling forever is a different defect from a seat
# stalling ten times, and silently papering over the first would hide it: when the budget runs out the
# watcher exits loudly with the history.
AUTO_MAX="${TKR_AUTO_SUPERSEDE_MAX:-20}"
AUTO_LOG="${TKR_AUTO_SUPERSEDE_LOG:-.tickmarkr/overseer/auto-supersede.log}"
auto=0

# ⚠ AUTO-SUPERSEDE SUBMITS A DRAFT THE SUPERVISING TIER NEVER READ. That is fine for "carry it to
# run-end" and catastrophic for "start the run", and NOTHING IN IT LOOKED AT THE CONTENT.
#
# Measured 2026-08-07. An orchestrator sat idle holding `❯ run doctor to refresh, then start the run`
# while the authority seat had not authorised any run — the seat's own last report said, correctly,
# *"run is yours to authorise."* Auto-supersede would have submitted it. **The only reason it did not is
# that the budget had run out at #20 one minute earlier.** Safety came from a LIMIT, not from a CHECK,
# and a limit is not a safety property — it is a coincidence with a counter.
#
# So: a draft naming a GATED or IRREVERSIBLE act is never auto-submitted. It wakes the supervisor, which
# is the one case where making the supervisor the bottleneck is the entire point.
# Bare verbs, not just `tickmarkr <verb>`: the draft that slipped through the first version of this
# matcher was the REAL one from 2026-08-07 10:26 — `approve --uphold T6, carry 2b to run-end` — which
# auto-supersede duly submitted. That is a GATE DECISION executed without the seat that owns gate
# decisions. **The cost is asymmetric: a false GATED merely wakes the supervisor, a false AUTO submits
# an authorisation nobody gave.** So bias toward GATED and accept the false wakes.
GATED_RE='tickmarkr (run|resume|approve)|(^|[^[:alnum:]])(approve|resume|uphold)([^[:alnum:]]|$)|npm publish|git (tag|push)|start the run|authoris?z?e the run'

# ⚠ THE DENYLIST ABOVE IS NOT THE SAFETY PROPERTY — THE ALLOWLIST BELOW IS.
#
# A denylist must enumerate every PHRASING of every dangerous act. It failed on 2026-08-07 at 20:32:39,
# submitting `run authorised — arm the four tiers and go` and STARTING A RUN NO SEAT HAD AUTHORISED.
# That text matches nothing above: not `start the run` and not `authoris?z?e the run` (word order), and
# `authorised` contains no standalone approve/resume/uphold. The incoming authority seat found it only
# by reading this log. The comment two paragraphs up had already named this exact catastrophe and the
# regex still did not implement it — **the policy was right and the matcher was a list of guesses.**
#
# So the direction is inverted: auto-supersede now requires a POSITIVE match on a known-benign shape.
# The two failure modes are not symmetric. An unrecognised draft that wakes the supervisor costs one
# wake; an unrecognised draft that is submitted costs whatever it said. Every entry in the 2026-08-07
# log that was genuinely safe to auto-submit is one of these shapes — the rest were instructions, and
# instructions are the supervisor's column by definition.
# ⚠ NARROWED 2026-08-07, ~40 minutes after the allowlist was written, by reading it adversarially
# instead of admiringly. The first version allowed `send `, `clear`, `read `, `report `, `status`.
# Two of those are not inert:
#   `send `  — auto-submits `send the release to npm`, which GATED_RE does not catch (it looks for
#              the literal `npm publish`). An allowlist entry that admits a publish is worse than
#              the denylist it replaced, because it reads as the considered fix.
#   `clear`  — wipes the receiving seat's working context mid-run. Destructive, and irreversible in
#              the only sense that matters: the context is gone.
#
# The line that survives scrutiny: auto-supersede may only ever cause a NOTIFICATION. Its safety then does
# not depend on knowing who wrote the draft — which matters here, because authorship of the first
# draft in each chain is UNRESOLVED (CORRECTION to OBS-448) and may stay that way. A guard whose
# correctness is conditional on an open question is not a guard.
#
# Everything else wakes the supervisor. That is more wakes; it is not more risk.
AUTO_ALLOW_RE='^(ping me|notify me|wake me)\b'

# ...and never supersede our OWN injection. The marker text lands in the seat's box, is read back as
# "pending input" on the next poll, and gets superseded again — nesting the message inside itself. Four
# of the twenty budget entries on 2026-08-07 were this, one of them doubly nested (#15). The mechanism
# was eating its own budget and would have exhausted it on nothing.
#
# ⚠ THIS GUARD WAS DEFEATED BY THE PANE'S WRAP BOUNDARY, and the trap is one this project has
# documented six times (OBS-396). `pending_text()` takes `head -1` — the FIRST rendered line of the
# box. A long injection wraps, so line 1 is a PREFIX of the marker: `<-- disregard everything before
# this`, with `arrow` on line 2. A fixed-string match on the whole sentence therefore returns FALSE on
# the watcher's own injection, and it re-wraps its own text and submits it again — a self-feeding loop.
# Measured 2026-08-07: entries #12, #14, #15, #17 in auto-supersede.log each carry the watcher's own
# prefix inside `$T`, and #15 shows the truncation directly. Found by the ORCHESTRATOR, not by this
# seat, and only because it was asked to enumerate rather than recall.
#
# So match the SHORTEST DISTINCTIVE TOKEN that cannot straddle a wrap — the same rule this project
# already applies to read-back probes. `<--` is three characters at position 1 of the injection.
# A false SELF match costs one skipped poll, which is the safe direction.
SELF_RE='<--|disregard'

streak=0
elapsed=0
while [ "$elapsed" -lt "$CAP" ]; do
  sleep "$POLL"
  elapsed=$((elapsed + POLL))

  S=$(status_of)
  if [ -z "$S" ]; then
    echo "TARGET_GONE $TARGET — agent get returned nothing (pane closed, or the name now resolves nowhere)"
    exit 0
  fi

  case "$S" in
    idle|done)
      T=$(pending_text)
      if [ -n "$T" ]; then
        streak=$((streak + 1))
        if [ "$streak" -ge "$CONFIRM" ]; then
          # TKR_AUTO_SUPERSEDE: unblock without waking the supervisor. Earned after TEN consecutive
          # benign occurrences on one seat in one night, every draft being that seat's own correct next
          # step. Waking a supervising tier to retype a seat's own instruction makes the supervisor the
          # bottleneck in a loop it adds no judgement to.
          # A gated act is the supervisor's decision, budget or no budget. Wake, never submit.
          if printf '%s' "$T" | grep -qEi -- "$GATED_RE"; then
            echo "PENDING_INPUT_GATED $TARGET status=$S sustained=$((streak * POLL))s"
            echo "  unsubmitted: $T"
            echo "  ⛔ this draft names a GATED or IRREVERSIBLE act, so auto-supersede REFUSED to submit it."
            echo "  It is one Enter from running. Decide it yourself, then supersede with YOUR decision:"
            echo "  herdr pane run <pane> \" <-- DISREGARD the line above (self-drafted, unauthorised). ACTUAL: …\""
            exit 0
          fi
          # Never re-supersede our own injected marker — it nests the message inside itself.
          if printf '%s' "$T" | grep -qE -- "$SELF_RE"; then
            streak=0
            continue
          fi
          if [ "${TKR_AUTO_SUPERSEDE:-0}" = "1" ] && [ "$auto" -lt "$AUTO_MAX" ] \
             && printf '%s' "$T" | grep -qEi -- "$AUTO_ALLOW_RE"; then
            auto=$((auto + 1))
            herdr agent prompt "$TARGET" \
              " <-- disregard everything before this arrow (stale unsubmitted draft, auto-detected). ACTUAL: proceed exactly as that draft said: ${T}" \
              >/dev/null 2>&1
            echo "$(date '+%H:%M:%S') auto-superseded #${auto}: ${T}" >> "${AUTO_LOG}"
            streak=0
            continue
          fi
          echo "PENDING_INPUT $TARGET status=$S sustained=$((streak * POLL))s"
          echo "  unsubmitted: $T"
          echo "  the seat is idle and holding live work in its prompt — supersede it, do not re-send:"
          echo "  herdr agent prompt $TARGET \" <-- disregard everything before this arrow (stale draft). ACTUAL: …\""
          # Name the ACTUAL reason we fell through. Saying "budget exhausted" when the cause was the
          # allowlist misattributes it, and a misattributed cause reads exactly like a verified one.
          if [ "${TKR_AUTO_SUPERSEDE:-0}" = "1" ]; then
            if [ "$auto" -ge "$AUTO_MAX" ]; then
              echo "  (auto-supersede budget of $AUTO_MAX exhausted — $AUTO_LOG has the history)"
            else
              echo "  (auto-supersede declined: draft is not on the benign allowlist — $auto/$AUTO_MAX used)"
            fi
          fi
          exit 0
        fi
      else
        streak=0
      fi
      ;;
    *) streak=0 ;;
  esac
done

echo "WATCH_CAP_REACHED $TARGET status=$(status_of) — no sustained pending input in ${CAP}s"
